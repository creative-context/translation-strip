// A stand-in for the voice linter, for the tests: `bun fake-lint.ts <file> --todo`. It prints
// findings in the real linter's format ("<file>:<line> <level> [<id>] <message>: «<hit>»", an
// indented context line, then a count) and exits 1 when there's an error, 0 otherwise.
import { readFileSync } from "node:fs";

const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: bun fake-lint.ts <file> [--todo]");
  process.exit(2);
}
let errors = 0;
readFileSync(file, "utf8")
  .split("\n")
  .forEach((line, i) => {
    if (/\bkindly\b/i.test(line)) {
      errors++;
      console.log(`${file}:${i + 1} error [stiff] Sounds stiff: «kindly»\n    ${line}`);
    }
  });
console.log(`${errors} errores, 0 avisos`);
process.exit(errors ? 1 : 0);
