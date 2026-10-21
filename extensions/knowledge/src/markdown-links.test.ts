import { expect, it } from "vitest";
import { connections } from "./connections.js";
import { markdown, extractLinks, resolveLinks, wikiHref } from "./markdown-links.js";
import { recordPath } from "./record-path.js";
import { useTestTempDirs } from "./test-support.js";

const tempDirs = useTestTempDirs();
const record = (id: any, title: any, path: any, body = "", extra = {}) => ({
  id,
  title,
  path,
  body,
  raw: body,
  hash: body,
  kind: "page",
  type: "person",
  valid: true,
  lifecycle: "active",
  revision: 1,
  metadata: { aliases: [], lifecycle: "active", ...extra },
});

it("Markdown tokenization excludes code, escapes, HTML, images and generated backlinks", () => {
  const body =
    '[Alex](../people/alex.md) [[Alex|A]]\n\n`[[Code]]`\n\n```md\n[[Fence]]\n```\n\n    [[Indent]]\n\n\\[[Escape]]\n\n<a href="people/html.md">HTML</a> ![image](people/image.md)\n\n<!-- backlinks:start -->\n[[Generated]]\n<!-- backlinks:end -->\n\n[ref][person]\n\n[person]: people/alex.md';
  expect(extractLinks(body)).toStrictEqual([
    "../people/alex.md",
    wikiHref("Alex"),
    "people/alex.md",
  ]);
});
it("comments are invisible while code examples and other HTML stay escaped", () => {
  const source =
    "Before <!-- project: path:/private/workspace --> after\n\n<!-- hidden\n[[Secret]]\n-->\n\n`<!-- inline example -->`\n\n```html\n<!-- fenced example -->\n```\n\n&lt;!-- escaped example --&gt;\n\n<script>unsafe()</script>";
  const rendered = markdown.parse(source);
  expect(rendered).not.toMatch(/private\/workspace|hidden|Secret/);
  expect(rendered).toMatch(/Before {2}after/);
  expect(rendered).toMatch(/&lt;!-- inline example --&gt;/);
  expect(rendered).toMatch(/&lt;!-- fenced example --&gt;/);
  expect(rendered).toMatch(/&lt;!-- escaped example --&gt;/);
  expect(rendered).toMatch(/&lt;script&gt;unsafe/);
  expect(extractLinks(source)).toStrictEqual([]);
});

it("backlink markers inside code do not suppress subsequent authored links", () => {
  expect(extractLinks("```html\n<!-- backlinks:start -->\n```\n\n[[Alex]]")).toStrictEqual([
    wikiHref("Alex"),
  ]);
});
it("current path, title, alias and old ID paths resolve; ambiguity never chooses an arbitrary target", () => {
  const alex = record("a", "Alex Rivera", "people/alex-rivera.md", "", { aliases: ["Alex"] }),
    other = record("b", "Blair", "people/blair.md");
  const source = record(
    "s",
    "Meeting",
    "meetings/team.md",
    "[[Alex]] [[people/alex-rivera#Notes|Alex]] [old](../people/a.md) [new](../people/alex-rivera.md) [[Missing]]",
  );
  expect(resolveLinks(source, [alex, other, source]).map((l) => l.id ?? l.status)).toStrictEqual([
    "a",
    "a",
    "a",
    "a",
    "missing",
  ]);
  (other.metadata as any).aliases = ["Alex"];
  expect(resolveLinks(source, [alex, other])[0]!.status).toBe("ambiguous");
  expect(resolveLinks(source, [other])[1]!.status).toBe("missing");
  alex.path = "people/renamed.md";
  expect(resolveLinks(source, [alex])[2]!.id).toBe("a");
});
it("derived backlinks deduplicate passages, reflect edits, exclude unavailable records and do not replace relationships", () => {
  const a = record("a", "Alex", "people/alex.md"),
    s = record(
      "s",
      "Meeting",
      "meetings/team.md",
      "[[Alex]] [[Alex#Note]] [Alex](../people/alex.md)",
    );
  const edge = {
    ...record("edge", "Works with", "relationships/works.md"),
    kind: "relationship",
    metadata: { lifecycle: "active", from: "a", to: "s", label: "works_with" },
  };
  const hidden = record("h", "Hidden", "people/hidden.md", "[[Alex]]", { record_class: "fixture" });
  const data = { records: [a, s, edge, hidden], issues: [] };
  const c = connections(data as any, { id: "a" });
  expect(c.connections.filter((r) => r.direction === "backlinks").length).toBe(1);
  expect(c.connections.filter((r) => r.direction === "outgoing").length).toBe(1);
  expect(connections(data as any, { id: "s", direction: "links" }).connections[0]!.record.id).toBe(
    "a",
  );
  expect(connections(data as any, { id: "a" }, new Set(["s"])).total).toBe(0);
  s.body = "No longer linked.";
  expect(connections(data as any, { id: "a", direction: "backlinks" }).total).toBe(0);
  expect(connections(data as any, { id: "a", direction: "outgoing" }).total).toBe(1);
});
it("unsafe or external destinations never resolve as local records", () => {
  const a = record("a", "Alex", "people/alex.md");
  const s = record(
    "s",
    "Meeting",
    "meetings/team.md",
    "[web](https://example.com/a.md) [file](file:///a.md) [[javascript:alert(1)]] [[../outside]] [bad](%ZZ.md)",
  );
  const links = resolveLinks(s, [a]);
  expect(links.length).toBe(3);
  expect(links.every((l) => l.status === "missing")).toBeTruthy();
});
it("descriptive filenames are safe, Unicode-aware and collision preserving", () => {
  expect(recordPath("people/", "Josh Lehman", "12345678-aaaa", () => false)).toBe(
    "people/josh-lehman.md",
  );
  expect(
    recordPath(
      "claims/",
      "Ship the release!",
      "12345678-aaaa",
      (p) => p === "claims/ship-the-release.md",
    ),
  ).toBe("claims/ship-the-release-12345678.md");
  expect(recordPath("people/", "../A / B", "12345678", () => false)).toBe("people/a-b.md");
  expect(!recordPath("people/", "東京", "12345678", () => false).includes("untitled")).toBeTruthy();
});

it("real scans expose scoped link resolutions and diagnostics without invalidating authored pages; renames rebuild navigation", async () => {
  const { cp, readFile, writeFile, rename } = await import("node:fs/promises");
  const { SampleVault } = await import("./vault.js");
  const { sampleVaultRoot } = await import("./plugin-files.js");
  const { inspectRecord } = await import("./inspection.js");
  const root = tempDirs.make("knowledge-links-");
  await cp(sampleVaultRoot(), root, { recursive: true });
  const file = root + "/people/alex-rivera.md";
  const before = await readFile(file, "utf8");
  await writeFile(file, before + "\n[[Missing page]] [self](alex-rivera.md)\n");
  const vault = new SampleVault(root),
    detail = await inspectRecord(vault, { id: "sample_person_alex" });
  expect(detail.record!.valid).toBeTruthy();
  expect(detail.links!.some((l) => l.status === "missing")).toBeTruthy();
  expect(detail.issues.some((i) => i.code === "missing-link")).toBeTruthy();
  expect(detail.links!.some((l) => l.id === "sample_person_alex")).toBeTruthy();
  await rename(file, root + "/people/alex-renamed.md");
  const changed = await inspectRecord(vault, { id: "sample_person_alex" });
  expect(changed.record!.path).toBe("people/alex-renamed.md");
  expect(changed.links!.find((l) => l.href === "alex-rivera.md")!.status).toBe("missing");
});
