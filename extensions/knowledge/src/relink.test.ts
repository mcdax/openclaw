import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { contract } from "./contract.js";
import { createKnowledgeService } from "./service.js";
import { apiFor, useTestTempDirs } from "./test-support.js";

const tempDirs = useTestTempDirs();

async function fixture(extraConfig = {}) {
  const base = tempDirs.make("knowledge-relink-");

  const root = path.join(base, "vault");
  await mkdir(root);
  await mkdir(path.join(root, "private"));
  const manifest = {
    format: "knowledge-vault-v2",
    vaultId: randomUUID(),
    generation: 0,
    publicationId: randomUUID(),
  };
  await writeFile(path.join(root, "vault.json"), JSON.stringify(manifest));
  const config = {
    root,
    statePath: path.join(base, "state.sqlite"),
    vaultId: manifest.vaultId,
    publicationId: manifest.publicationId,
    operatorRead: true,
    writesEnabled: true,
    ...extraConfig,
  };
  const api = apiFor(base, config),
    service = createKnowledgeService(api);
  const owner: any = {
    source: "tool",
    api,
    tool: {
      agentId: "main",
      memoryAudience: { kind: "owner-private", agentId: "main" },
      assertInvocationCurrent() {},
      assertMemoryAudienceCurrent() {},
    },
  };
  const operator: any = {
    source: "session-action",
    api,
    action: { client: { connId: "test", scopes: ["operator.write"] } },
  };
  const page = (title: any, type = "project", extra = {}) =>
    service.save_page({ requestId: randomUUID(), title, type, body: "Page.\n", ...extra }, owner);
  // Saved unlinked: inference is off, as when the subject page did not exist yet.
  const remember = (text: any, kind: any = "fact") =>
    service.remember(
      {
        requestId: randomUUID(),
        attribution: "user in test session, 2026-10-20",
        excerpt: `User: ${text}`,
        items: [{ text, kind, infer_subject: false }],
      },
      owner,
    );
  const relink = async (input: any) => {
    const out = await service.relink(input, owner);
    expect(Check(contract.operations.relink.output, out)).toBeTruthy();
    return out;
  };
  const entities = async (id: any) =>
    (await service.record({ id, includeMetadata: true }, owner)).record!.metadata!.entities;
  return { service, owner, operator, page, remember, relink, entities };
}

it("relink links unique mentions, leaves ambiguous and unnamed claims, and a repeat pass links nothing", async () => {
  const f = await fixture();
  const atlas = (await f.remember("Atlas Labs moved its launch to March.")).items[0]!.id;
  const both = (await f.remember("Atlas Labs and Nimbus Works signed a pact.")).items[0]!.id;
  const none = (await f.remember("I prefer short replies.", "preference")).items[0]!.id;
  const meeting = (await f.remember("Discussed pricing in Weekly Sync.")).items[0]!.id;
  expect(await f.entities(atlas)).toBe(undefined);
  const atlasPage = await f.page("Atlas Labs", "company"),
    nimbus = await f.page("Nimbus Works", "company");
  await f.page("Weekly Sync", "meeting");

  const preview = await f.relink({ dryRun: true });
  expect([
    preview.dryRun,
    preview.scanned,
    preview.linked,
    preview.ambiguous,
    preview.noSubject,
  ]).toStrictEqual([true, 4, 1, 1, 2]);
  expect(await f.entities(atlas), "A dry run publishes nothing").toBe(undefined);
  expect(preview.examples.find((e) => e.outcome === "linked")).toStrictEqual({
    id: atlas,
    title: "Atlas Labs moved its launch to March.",
    outcome: "linked",
    tier: "mention",
    subject: { id: atlasPage.id, title: "Atlas Labs" },
  });

  const run = await f.relink({});
  expect([run.linked, run.ambiguous, run.noSubject, run.failed, run.nextCursor]).toStrictEqual([
    1,
    1,
    2,
    0,
    null,
  ]);
  expect(await f.entities(atlas)).toStrictEqual([atlasPage.id]);
  expect(await f.entities(both), "Two named entities stay unlinked").toBe(undefined);
  expect(await f.entities(none)).toBe(undefined);
  expect(await f.entities(meeting), "A meeting page is not a claim subject").toBe(undefined);
  const read = await f.service.record({ id: atlas, includeMetadata: true }, f.owner);
  expect(read.record!.body).toBe("Atlas Labs moved its launch to March.");
  expect(read.record!.lifecycle).toBe("active");
  expect(read.record!.revision).toBe(2);
  const claims = await f.service.connections({ id: atlasPage.id, direction: "claims" }, f.owner);
  expect(claims.connections.map((c) => c.record.id)).toStrictEqual([atlas]);

  const again = await f.relink({});
  expect(
    [again.scanned, again.linked, again.failed],
    "Linked claims leave the candidate set; nothing new links",
  ).toStrictEqual([3, 0, 0]);
  expect(nimbus.id).toBeTruthy();
});

it("relink uses a recorded source entity page, pages with a cursor, and only runs through agent tools", async () => {
  const f = await fixture();
  const ids = [];
  for (let i = 0; i < 3; i++) {
    ids.push((await f.remember(`Orbit Garden note ${i}.`)).items[0]!.id);
  }
  const orbit = await f.page("Orbit Garden");
  const first = await f.relink({ limit: 2 });
  expect(first.scanned).toBe(2);
  expect(first.linked).toBe(2);
  expect(first.nextCursor).toBeTruthy();
  const second = await f.relink({ limit: 2, cursor: first.nextCursor });
  expect(second.scanned).toBe(1);
  expect(second.linked).toBe(1);
  expect(second.nextCursor).toBe(null);
  for (const id of ids) {
    expect(await f.entities(id)).toStrictEqual([orbit.id]);
  }
  await expect(f.service.relink({}, f.operator)).rejects.toThrow(/through chat and agent tools/);
  await expect(f.service.relink({ dryRun: true }, f.operator)).rejects.toThrow(
    /through chat and agent tools/,
  );

  // A claim annotated with an entity source page links through the page tier,
  // even when its text names nothing.
  const quiet = (await f.remember("Nothing named here.")).items[0]!.id;
  const r = (await f.service.record({ id: quiet }, f.owner)).record;
  await f.service.annotate(
    {
      requestId: randomUUID(),
      id: quiet,
      expectedRevision: r!.revision,
      expectedHash: r!.hash,
      reason: "Recorded source",
      annotations: { source_page: orbit.id },
    },
    f.owner,
  );
  const out = await f.relink({});
  expect(out.examples.find((e) => e.id === quiet)!.tier).toBe("page");
  expect(await f.entities(quiet)).toStrictEqual([orbit.id]);
});

it("relink ignores claims that knowledge_remember did not save", async () => {
  const f = await fixture();
  await f.page("Atlas Labs", "company");
  const fingerprint = (await f.service.ontology({}, f.owner)).fingerprint;
  const upload = await f.service.attach(
    {
      requestId: randomUUID(),
      filename: "source.txt",
      mediaType: "text/plain",
      attribution: "Synthetic",
      offset: 0,
      data: Buffer.from("Atlas Labs shipped.").toString("base64"),
      final: true,
    },
    f.owner,
  );
  const authored = await f.service.create_claim(
    {
      requestId: randomUUID(),
      expectedOntologyFingerprint: fingerprint,
      title: "Shipped",
      body: "Atlas Labs shipped.",
      claim_kind: "event",
      assertion_origin: "source",
      attribution: "Synthetic",
      evidence: [{ ...upload.evidence, start_line: 1, end_line: 1 } as any],
    },
    f.owner,
  );
  const out = await f.relink({});
  expect(out.scanned).toBe(0);
  expect(
    await f.entities(authored.id),
    "Deliberately unlinked authored claims are not maintenance targets",
  ).toBe(undefined);
});

it("relink treats plural weekdays and time words as common words, not competing names", async () => {
  const f = await fixture();
  const rota = (await f.remember("The on-call rotation for Harbor Works moved to Tuesdays."))
    .items[0]!.id;
  const harbor = await f.page("Harbor Works");
  const run = await f.relink({});
  expect([run.linked, run.ambiguous, run.noSubject]).toStrictEqual([1, 0, 0]);
  expect(await f.entities(rota)).toStrictEqual([harbor.id]);
});
