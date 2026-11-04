#!/usr/bin/env node
/**
 * Guards the one thing a broken manifest costs: a published version that pi
 * cannot load. Run by CI on every push, and again on the release tag before
 * `npm publish`.
 */

import { existsSync, readFileSync } from "node:fs";

const fail = (message) => {
	console.error(`check-manifest: ${message}`);
	process.exit(1);
};

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

if (!pkg.name) fail("package.json has no name");
if (!/^\d+\.\d+\.\d+$/.test(pkg.version ?? "")) fail(`version is not semver: ${pkg.version}`);
if (!pkg.description) fail("package.json has no description");
if (pkg.license !== "MIT") fail(`expected an MIT license, got ${pkg.license}`);
if (!Array.isArray(pkg.keywords) || !pkg.keywords.includes("pi-package")) {
	fail("keywords must include pi-package, or the gallery will not list the package");
}

const extensions = pkg.pi?.extensions;
if (!Array.isArray(extensions) || extensions.length === 0) {
	fail("pi.extensions must name at least one entry point");
}

for (const entry of extensions) {
	if (!existsSync(new URL(`../${entry}`, import.meta.url))) fail(`pi.extensions entry is missing: ${entry}`);
}

if (!Array.isArray(pkg.files)) fail("files whitelist is missing");
for (const file of pkg.files) {
	if (!existsSync(new URL(`../${file}`, import.meta.url))) fail(`files lists a missing path: ${file}`);
}

// State files must never ship: they hold approvals and another user's commands.
for (const forbidden of ["approvals.json", "denials.json", "pending-retry.json"]) {
	if (pkg.files.includes(forbidden)) fail(`files must not include state: ${forbidden}`);
}

// Every module imported by index.ts has to be in the tarball.
const entry = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const local = [...entry.matchAll(/from "\.\/([^"]+)"/g)].map((match) => match[1]);
for (const module of local) {
	if (!pkg.files.includes(module)) fail(`index.ts imports ./${module}, which files does not list`);
}

console.log(`check-manifest: ok — ${pkg.name}@${pkg.version}, ${pkg.files.length} files, entry ${extensions.join(", ")}`);
