// The vendored files weren't edited: kit.json (mac-app-kit) and public/design.json (mac-app-design)
// each list their files with a sha256, and each file starts with a line naming the manifest's
// version. A file that was edited, replaced by another version or left out of its manifest fails
// by name. Fix it in the kit or the design system, then vendor again; never edit the copy here.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

type Manifest = { name: string; version: string; repo: string; commit: string; files: Record<string, string> };
const read = (p: string) => readFileSync(p);
const manifest = (p: string): Manifest => JSON.parse(readFileSync(p, "utf8"));
const sha256 = (p: string) => createHash("sha256").update(read(p)).digest("hex");

const sets = [
  { label: "kit.json", file: join(ROOT, "kit.json"), base: ROOT, vendored: (m: Manifest) => Object.keys(m.files).length > 0 },
  { label: "public/design.json", file: join(ROOT, "public/design.json"), base: join(ROOT, "public"), vendored: (m: Manifest) => Object.keys(m.files).length > 0 },
];

for (const set of sets) {
  const m = manifest(set.file);
  describe(`${set.label} (${m.name} ${m.version})`, () => {
    test("names its version, repo, commit and files", () => {
      expect(m.name).toMatch(/^mac-app-/);
      expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(m.repo).toMatch(/^creative-context\/mac-app-/);
      expect(m.commit).toMatch(/^[0-9a-f]{7,40}$/);
      expect(set.vendored(m)).toBe(true);
    });

    for (const [rel, want] of Object.entries(m.files)) {
      const path = join(set.base, rel);
      test(`${rel}: same bytes as when vendored`, () => {
        let got: string;
        try {
          got = sha256(path);
        } catch {
          throw new Error(`${rel} is listed in ${set.label} but can't be read`);
        }
        if (got !== want) throw new Error(`${rel} was edited: sha256 ${got.slice(0, 12)}… is not the ${want.slice(0, 12)}… in ${set.label}. Change it in ${m.repo} and vendor it again.`);
      });

      test(`${rel}: first lines name ${m.name} ${m.version}`, () => {
        const head = read(path).toString("utf8").split("\n").slice(0, 3).join("\n");
        if (!head.includes(`${m.name} ${m.version}`)) throw new Error(`${rel}: the first lines don't say "${m.name} ${m.version}" (the version in ${set.label}). It's from another version of ${m.repo}.`);
        expect(head).toContain("Vendored: don't edit here");
      });
    }
  });
}

describe("nothing vendored is missing from its manifest", () => {
  test("public/design-* files are all listed in design.json", () => {
    const listed = Object.keys(manifest(join(ROOT, "public/design.json")).files);
    const onDisk = readdirSync(join(ROOT, "public")).filter((f) => f.startsWith("design-"));
    for (const f of onDisk) if (!listed.includes(f)) throw new Error(`public/${f} looks vendored but isn't listed in public/design.json, so nothing protects it`);
    expect(onDisk.length).toBeGreaterThan(0);
  });

  test("the kit's server and shell files are listed in kit.json", () => {
    const listed = Object.keys(manifest(join(ROOT, "kit.json")).files);
    for (const f of ["src/server-kit.ts", "app/ShellKit.swift"]) if (!listed.includes(f)) throw new Error(`${f} isn't listed in kit.json, so nothing protects it`);
  });
});
