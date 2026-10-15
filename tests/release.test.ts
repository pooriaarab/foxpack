import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const text = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
/** The jobs of the workflow, each as its block of text. A job is a key two spaces in under `jobs:`. */
const jobs = Object.fromEntries(
  text.slice(text.indexOf("\njobs:\n") + 7).split(/\n(?=  [\w-]+:\n)/).map((block) => [block.match(/^ {2}([\w-]+):/)?.[1] ?? "", block]),
);
const holding = (pattern: RegExp) => Object.keys(jobs).filter((name) => pattern.test(jobs[name] ?? ""));
const needs = (name: string) => (jobs[name]?.match(/^ {4}needs: \[(.*)\]$/m)?.[1] ?? "").split(", ").filter(Boolean);

describe("release.yml", () => {
  it("R1: the workflow grants nothing; id-token and contents: write sit in one job each", () => {
    expect(text).toMatch(/^permissions: \{\}$/m);
    for (const block of Object.values(jobs)) expect(block).toMatch(/^ {4}permissions:/m);
    expect(holding(/id-token: write/)).toEqual(["npm"]);
    expect(holding(/contents: write/)).toEqual(["github-release"]);
  });

  it("R2: one build, passed on; no install where the npm token or id-token is", () => {
    expect(Object.keys(jobs)).toEqual(["check", "e2e", "npm", "amo", "github-release"]);
    expect(holding(/pnpm (?:install|ci:local|build)/)).toEqual(["check", "e2e", "amo"]);
    expect(jobs.check).toMatch(/upload-artifact@[0-9a-f]{40}/);
    expect(jobs.npm).not.toMatch(/pnpm|actions\/checkout/);
    expect(jobs.npm).toMatch(/npm publish "\$TARBALL" --provenance --access public/);
    expect(holding(/secrets\.NPM_TOKEN/)).toEqual(["npm"]);
    expect(holding(/secrets\.AMO_JWT_/)).toEqual(["amo"]);
    expect(jobs.amo).toMatch(/pnpm install --frozen-lockfile --ignore-scripts/);
    // The AMO keys are in the env of the signing step only, after the install.
    expect(jobs.amo?.indexOf("AMO_JWT_ISSUER: ${{")).toBeGreaterThan(jobs.amo?.indexOf("--ignore-scripts") ?? Infinity);
  });

  it("R3: the E2E on Ichabod runs on the build before anything is published", () => {
    expect(needs("e2e")).toEqual(["check"]);
    expect(needs("npm")).toEqual(["check", "e2e"]);
    expect(needs("amo")).toEqual(["check", "e2e", "npm"]);
    expect(jobs.e2e).toMatch(/ICHABOD_API_KEY: \$\{\{ secrets\.ICHABOD_API_KEY \}\}/);
    expect(jobs.e2e).toMatch(/FOXKIT_BROWSER: ichabod/);
    expect(jobs.e2e).toMatch(/node e2e\/run\.mjs/);
    expect(jobs.e2e).toMatch(/download-artifact@[0-9a-f]{40}/);
  });

  it("R4: cloudflared is a pinned release with a sha256", () => {
    expect(jobs.e2e).toMatch(/cloudflared\/releases\/download\/\d{4}\.\d+\.\d+\/cloudflared-linux-amd64/);
    expect(jobs.e2e).toMatch(/[0-9a-f]{64} {2}\$RUNNER_TEMP\/cloudflared" \| sha256sum -c/);
  });
});
