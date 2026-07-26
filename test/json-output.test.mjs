// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  cleanupTempRepo,
  createTempRepo,
  fakeGitEnv,
  readFile,
  repoRoot,
  run,
  setPrecommitConfig,
  writeFile,
} from "./helpers/temp-repo.mjs";
import {
  JSON_OUTPUT_SCHEMA_VERSION,
  allowedStatus,
  createJsonOutput,
  issueToJsonFinding,
  normalizeProcessOutcome,
  parseJsonOutputArgs,
  writeAllSync,
} from "../scripts/lib/json-output.mjs";

const jsonOutputSchema = JSON.parse(
  fs.readFileSync(path.resolve("docs/json-output.schema.json"), "utf8"),
);

// Preserve the strict finding shape shipped before debug-artifact subtypes.
// Schema v1 forbids undeclared top-level fields, so every v1 payload must keep
// validating against this shape even as check-specific details grow.
const preDebugArtifactV1FindingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["check", "severity", "message", "autoFixable", "details"],
  properties: {
    check: { type: "string" },
    severity: { enum: ["warning", "error"] },
    message: { type: "string" },
    autoFixable: { type: "boolean" },
    details: { type: "array", items: { type: "string" } },
  },
};

function assertSchemaValue(value, schema, pointer = "$") {
  if (schema.$ref) {
    const referenced = schema.$ref
      .slice(2)
      .split("/")
      .reduce((current, key) => current[key], jsonOutputSchema);
    assertSchemaValue(value, referenced, pointer);
    return;
  }

  if (schema.type === "object") {
    assert.ok(
      value !== null && typeof value === "object" && !Array.isArray(value),
      `${pointer} is an object`,
    );
    for (const key of schema.required ?? []) {
      assert.ok(Object.hasOwn(value, key), `${pointer}.${key} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        assert.ok(
          Object.hasOwn(schema.properties, key),
          `${pointer}.${key} is declared by the schema`,
        );
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) {
        assertSchemaValue(value[key], childSchema, `${pointer}.${key}`);
      }
    }
  } else if (schema.type === "array") {
    assert.ok(Array.isArray(value), `${pointer} is an array`);
    value.forEach((item, index) =>
      assertSchemaValue(item, schema.items, `${pointer}[${index}]`),
    );
  } else if (schema.type === "integer") {
    assert.ok(Number.isInteger(value), `${pointer} is an integer`);
  } else if (schema.type) {
    assert.equal(typeof value, schema.type, `${pointer} is a ${schema.type}`);
  }

  if (Object.hasOwn(schema, "const")) {
    assert.deepEqual(value, schema.const, `${pointer} matches its constant`);
  }
  if (schema.enum) {
    assert.ok(schema.enum.includes(value), `${pointer} matches its enum`);
  }
  if (schema.minimum !== undefined) {
    assert.ok(value >= schema.minimum, `${pointer} meets its minimum`);
  }
}

function cli(tempDir, args, options = {}) {
  return run(
    process.execPath,
    [path.join(tempDir, "scripts", "cli.mjs"), ...args],
    tempDir,
    options,
  );
}

function jsonPayload(result) {
  assert.match(result.stdout, /^\{.*\}\n$/s);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.schemaVersion, JSON_OUTPUT_SCHEMA_VERSION);
  assert.equal(payload.exitCode, result.status);
  assertSchemaValue(payload, jsonOutputSchema);
  payload.findings.forEach((finding, index) =>
    assertSchemaValue(
      finding,
      preDebugArtifactV1FindingSchema,
      `$.findings[${index}] (pre-debug-artifact v1 shape)`,
    ),
  );
  for (const key of [
    "command",
    "mode",
    "status",
    "summary",
    "checks",
    "findings",
    "suggestions",
    "diagnostics",
  ]) {
    assert.ok(Object.hasOwn(payload, key), `payload has ${key}`);
  }
  return payload;
}

function commitConfig(tempDir, config) {
  setPrecommitConfig(tempDir, config);
  run("git", ["add", "package.json"], tempDir);
  run("git", ["commit", "-m", "configure checks"], tempDir);
}

function pushInput(tempDir) {
  const head = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();
  const base = run("git", ["rev-parse", "HEAD~1"], tempDir).stdout.trim();
  return `refs/heads/main ${head} refs/heads/main ${base}\n`;
}

function addPushedTestFixture(tempDir) {
  writeFile(
    path.join(tempDir, "src", "widget.mjs"),
    "export const widget = () => 1;\n",
  );
  writeFile(path.join(tempDir, "src", "widget.test.mjs"), "export {};\n");
  run("git", ["add", "src"], tempDir);
  run("git", ["commit", "-m", "add widget"], tempDir);
}

function configureCustomPushRunner(
  tempDir,
  { blocking = false, exit = 0, hookOutput },
) {
  writeFile(
    path.join(tempDir, "json-test-runner.mjs"),
    `process.stdout.write("child stdout sentinel\\n");
process.stderr.write("child stderr sentinel\\n");
process.exit(${exit});
`,
  );
  const config = {
    protectedBranches: [],
    testCommand: ["node", "json-test-runner.mjs"],
    ...(hookOutput ? { hookOutput } : {}),
    ...(blocking
      ? { blockPushOnTestFailure: true }
      : { advisePushTests: true }),
  };
  setPrecommitConfig(tempDir, config);
  run("git", ["add", "package.json", "json-test-runner.mjs"], tempDir);
  run("git", ["commit", "-m", "configure push checks"], tempDir);
}

test("JSON helpers parse supported arguments and normalize findings", () => {
  assert.equal(allowedStatus([], "skipped"), "skipped");
  assert.equal(allowedStatus([{}], "clean"), "advisory");

  assert.deepEqual(parseJsonOutputArgs(["--json"]), {
    enabled: true,
    positionals: [],
    error: null,
  });
  assert.deepEqual(
    parseJsonOutputArgs(
      ["origin", "https://example.invalid/repo", "--json"],
      2,
    ),
    {
      enabled: true,
      positionals: ["origin", "https://example.invalid/repo"],
      error: null,
    },
  );
  assert.match(parseJsonOutputArgs(["--json", "--json"]).error, /once/);
  assert.match(parseJsonOutputArgs(["--json=pretty"]).error, /without a value/);
  assert.match(parseJsonOutputArgs(["--json", "--wat"]).error, /--wat/);
  assert.match(
    parseJsonOutputArgs(["--json", "one", "two"], 1).error,
    /at most 1 positional argument/,
  );

  assert.deepEqual(
    issueToJsonFinding({
      type: "format",
      message: "format it",
      autoFixable: true,
      detail: "a.js\nb.js",
    }),
    {
      check: "format",
      severity: "warning",
      message: "format it",
      autoFixable: true,
      details: ["a.js", "b.js"],
    },
  );
  assert.deepEqual(issueToJsonFinding({ detail: [1, "two"] }).details, [
    "1",
    "two",
  ]);
  assert.equal(
    issueToJsonFinding({ id: "debug-artifacts.detected" }).id,
    undefined,
  );

  assert.equal(
    normalizeProcessOutcome({
      outcome: "timeout",
      timedOut: true,
      status: null,
      signal: null,
    }),
    "timeout",
  );
  assert.equal(
    normalizeProcessOutcome({ timedOut: true, status: null, signal: null }),
    "timeout",
  );
  assert.equal(
    normalizeProcessOutcome({ status: null, signal: "SIGTERM" }),
    "timeout",
  );
  assert.equal(
    normalizeProcessOutcome({ status: null, signal: "SIGKILL" }),
    "signal",
  );
  assert.equal(
    normalizeProcessOutcome({ status: null, signal: "SIGINT" }),
    "signal",
  );
  assert.equal(
    normalizeProcessOutcome({ outcome: "signal", signal: "SIGTERM" }),
    "signal",
  );
  assert.equal(
    normalizeProcessOutcome({ error: { code: "ENOENT" }, status: null }),
    "spawn-error",
  );
  assert.equal(
    normalizeProcessOutcome({ missingTool: "eslint", status: null }),
    "missing-tool",
  );
  assert.equal(normalizeProcessOutcome({ status: 2 }), "nonzero");
  assert.equal(normalizeProcessOutcome({ status: 0 }), "success");
  assert.equal(normalizeProcessOutcome({}), "spawn-error");

  const output = createJsonOutput({ command: "precommit", mode: "advisory" });
  output.addCheck({ id: "example", status: "unknown", summary: "fallback" });
  output.addDiagnostic({
    severity: "error",
    code: "example.error",
    message: "bad input",
  });
  const result = output.result({
    status: "error",
    exitCode: 1,
    summary: "bad",
  });
  assert.equal(result.checks[0].status, "failed");
  assert.deepEqual(result.checks[0].details, {});
  assert.equal(result.diagnostics[0].severity, "error");
});

test("complete synchronous writes survive partial pipe progress", () => {
  const chunks = [];
  let temporarilyBlocked = true;
  const writer = (_fd, buffer, offset, length) => {
    if (temporarilyBlocked) {
      temporarilyBlocked = false;
      throw Object.assign(new Error("pipe busy"), { code: "EAGAIN" });
    }
    const written = Math.min(length, 7);
    chunks.push(buffer.subarray(offset, offset + written));
    return written;
  };

  writeAllSync(1, "large output: snow 雪\n", writer);
  writeAllSync(1, Buffer.from("buffer input\n"), writer);
  assert.equal(
    Buffer.concat(chunks).toString("utf8"),
    "large output: snow 雪\nbuffer input\n",
  );
  assert.throws(() => writeAllSync(1, "stalled", () => 0), /made no progress/);
  assert.throws(
    () => writeAllSync(1, "invalid", () => 0.5),
    /made no progress/,
  );
  assert.throws(
    () =>
      writeAllSync(1, "broken", () => {
        throw Object.assign(new Error("broken pipe"), { code: "EPIPE" });
      }),
    /broken pipe/,
  );
});

test("large JSON output is complete before an immediate exit", () => {
  const script = `
import { createJsonOutput } from "./scripts/lib/json-output.mjs";
const output = createJsonOutput({ command: "precommit", mode: "advisory" });
output.addCheck({
  id: "large-result",
  status: "passed",
  summary: "large result",
  details: { padding: "x".repeat(128 * 1024) },
});
output.emit({ status: "clean", exitCode: 0, summary: "complete" });
process.exit(0);
`;
  const result = run(
    process.execPath,
    ["--input-type=module", "--eval", script],
    repoRoot,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.checks[0].details.padding.length, 128 * 1024);
  assert.ok(result.stdout.endsWith("\n"));
});

test("precommit --json reports skipped and clean states", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  let result = cli(tempDir, ["precommit", "--json"]);
  let payload = jsonPayload(result);
  assert.equal(result.stderr, "");
  assert.equal(payload.command, "precommit");
  assert.equal(payload.status, "skipped");

  commitConfig(tempDir, { protectedBranches: [], requireTests: false });
  writeFile(path.join(tempDir, "src", "clean.json"), '{ "ok": true }\n');
  run("git", ["add", "src/clean.json"], tempDir);

  result = cli(tempDir, ["precommit", "--json"]);
  payload = jsonPayload(result);
  assert.equal(result.stderr, "");
  assert.equal(payload.status, "clean");
  assert.equal(payload.findings.length, 0);
  assert.equal(
    payload.checks.find((check) => check.id === "prettier").status,
    "passed",
  );
});

test("hookOutput does not change precommit JSON payloads", (t) => {
  const quietDir = createTempRepo();
  const normalDir = createTempRepo();
  t.after(() => cleanupTempRepo(quietDir));
  t.after(() => cleanupTempRepo(normalDir));

  for (const [dir, hookOutput] of [
    [quietDir, "problems-only"],
    [normalDir, "normal"],
  ]) {
    commitConfig(dir, {
      hookOutput,
      protectedBranches: [],
      requireTests: false,
    });
    writeFile(path.join(dir, "src", "clean.json"), '{ "ok": true }\n');
    run("git", ["add", "src/clean.json"], dir);
  }

  const quiet = jsonPayload(cli(quietDir, ["precommit", "--json"]));
  const normal = jsonPayload(cli(normalDir, ["precommit", "--json"]));

  assert.deepEqual(quiet, normal);
});

test("JSON mode reports only effective blocking posture", (t) => {
  const precommitDir = createTempRepo();
  const disabledPushDir = createTempRepo();
  const advisoryPushDir = createTempRepo();
  t.after(() => cleanupTempRepo(precommitDir));
  t.after(() => cleanupTempRepo(disabledPushDir));
  t.after(() => cleanupTempRepo(advisoryPushDir));

  setPrecommitConfig(precommitDir, {
    blockOnSecrets: true,
    scanSecrets: false,
    blockProtectedBranches: true,
    protectedBranches: [],
    requireTests: false,
  });
  writeFile(path.join(precommitDir, "src", "clean.json"), '{ "ok": true }\n');
  run("git", ["add", "src/clean.json"], precommitDir);
  let payload = jsonPayload(cli(precommitDir, ["precommit", "--json"]));
  assert.equal(payload.mode, "advisory");

  setPrecommitConfig(disabledPushDir, {
    blockProtectedBranches: true,
    protectedBranches: [],
  });
  payload = jsonPayload(cli(disabledPushDir, ["prepush", "--json"]));
  assert.equal(payload.mode, "disabled");

  setPrecommitConfig(advisoryPushDir, { protectedBranches: ["main"] });
  payload = jsonPayload(cli(advisoryPushDir, ["prepush", "--json"]));
  assert.equal(payload.mode, "advisory");
});

test("precommit --json reports advisory findings and a safe command", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  commitConfig(tempDir, { protectedBranches: [], requireTests: false });
  writeFile(path.join(tempDir, "src", "format.json"), '{"ok":true}\n');
  run("git", ["add", "src/format.json"], tempDir);

  const result = cli(tempDir, ["precommit", "--json"]);
  const payload = jsonPayload(result);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(payload.status, "advisory");
  assert.ok(payload.findings.some((finding) => finding.check === "format"));
  assert.match(payload.suggestions[0].command, /commit:fix/);
  assert.doesNotMatch(result.stdout, /Pre-commit suggestions found|╭|╰/);
});

test("precommit JSON exposes stable debug check, rule, and subtype ids", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  commitConfig(tempDir, {
    debugArtifactExempt: [],
    protectedBranches: [],
    requireTests: false,
    scanDebugArtifacts: true,
    scanSecrets: false,
  });
  writeFile(path.join(tempDir, "src", "app.py"), "pdb.set_trace()\n");
  run("git", ["add", "src/app.py"], tempDir);

  let result = cli(tempDir, ["precommit", "--json"]);
  let payload = jsonPayload(result);
  const check = payload.checks.find(({ id }) => id === "debug-artifacts");
  const finding = payload.findings.find(
    ({ check: findingCheck }) => findingCheck === "debug-artifacts",
  );

  assert.equal(result.status, 0);
  assert.equal(payload.status, "advisory");
  assert.equal(check.status, "advisory");
  assert.equal(check.details.findingId, "debug-artifacts.detected");
  assert.deepEqual(check.details.findings, [
    {
      file: "src/app.py",
      line: 1,
      ruleId: "python.pdb-set-trace",
      label: "pdb.set_trace call",
    },
  ]);
  assert.equal(finding.check, "debug-artifacts");
  assert.equal(finding.severity, "warning");

  result = cli(tempDir, ["precommit", "--json"], {
    env: fakeGitEnv(tempDir, "diff-tree --no-commit-id --no-renames -r -U0"),
  });
  payload = jsonPayload(result);
  assert.equal(result.status, 0);
  assert.equal(payload.status, "advisory");
  assert.equal(payload.findings[0].check, "debug-artifacts");
  assert.equal(payload.findings[0].id, undefined);
  assert.equal(
    payload.checks.find(({ id }) => id === "debug-artifacts").details.findingId,
    "debug-artifacts.unavailable",
  );
});

test(
  "precommit JSON preserves an exact control-character filename",
  { skip: process.platform === "win32" },
  (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));
    const file = "src/json\rline\n\t\b\u001b[31mRED\u001b[39m.mjs";
    writeFile(path.join(tempDir, file), "export const value = 1;\n");
    run("git", ["add", "--", file], tempDir);

    const result = cli(tempDir, ["precommit", "--json"]);
    const payload = jsonPayload(result);
    const missingTests = payload.findings.find(
      (finding) => finding.check === "tests",
    );

    assert.equal(result.stderr, "");
    assert.deepEqual(missingTests.details, [file]);
    assert.deepEqual(
      payload.checks.find((check) => check.id === "missing-tests").details
        .sourceFiles,
      [file],
    );
    assert.match(
      result.stdout,
      /json\\rline\\n\\t\\b\\u001b\[31mRED\\u001b\[39m\.mjs/,
    );
  },
);

test("JSON configuration diagnostics stay structured", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, {
    requireTest: false,
    requireTests: "nope",
    commitMessage: { blockOnFailure: true },
  });
  const result = cli(tempDir, ["precommit", "--json"]);
  const payload = jsonPayload(result);

  assert.equal(result.stderr, "");
  assert.equal(payload.diagnostics[0].code, "config.unknown-keys");
  assert.match(payload.diagnostics[0].message, /requireTest/);
  assert.equal(payload.diagnostics[1].code, "config.invalid-values");
  assert.match(payload.diagnostics[1].message, /requireTests/);
  assert.equal(payload.diagnostics[2].code, "config.ineffective-value");
  assert.match(payload.diagnostics[2].message, /blockOnFailure/);
});

test("JSON configuration diagnostics identify standalone sources", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(
    path.join(tempDir, ".commitmentrc.json"),
    '{"requireTest":false,"requireTests":"nope"}\n',
  );
  let result = cli(tempDir, ["precommit", "--json"]);
  let payload = jsonPayload(result);

  assert.equal(result.stderr, "");
  assert.deepEqual(
    payload.diagnostics.map(({ code }) => code),
    ["config.unknown-keys", "config.invalid-values"],
  );
  assert.match(payload.diagnostics[0].message, /\.commitmentrc\.json/);
  assert.match(payload.diagnostics[1].message, /\.commitmentrc\.json/);

  writeFile(path.join(tempDir, ".commitmentrc.json"), "{ invalid\n");
  result = cli(tempDir, ["precommit", "--json"]);
  payload = jsonPayload(result);
  assert.equal(payload.diagnostics[0].code, "config.invalid-source");
  assert.match(payload.diagnostics[0].message, /contains invalid JSON/);
});

test("precommit JSON covers blocking and fail-open guard outcomes", (t) => {
  const branchDir = createTempRepo();
  const secretDir = createTempRepo();
  const gitDir = createTempRepo();
  const missingGitDir = createTempRepo();
  const earlyDir = createTempRepo();
  t.after(() => cleanupTempRepo(branchDir));
  t.after(() => cleanupTempRepo(secretDir));
  t.after(() => cleanupTempRepo(gitDir));
  t.after(() => cleanupTempRepo(missingGitDir));
  t.after(() => cleanupTempRepo(earlyDir));

  setPrecommitConfig(branchDir, {
    blockProtectedBranches: true,
    protectedBranches: ["main", "master"],
  });
  let result = cli(branchDir, ["precommit", "--json"]);
  let payload = jsonPayload(result);
  assert.equal(payload.status, "blocked");
  assert.equal(payload.findings[0].check, "branch");

  commitConfig(secretDir, {
    blockOnSecrets: true,
    protectedBranches: [],
  });
  writeFile(path.join(secretDir, ".env"), "PASSWORD=not-printed\n");
  run("git", ["add", ".env"], secretDir);
  result = cli(secretDir, ["precommit", "--json"]);
  payload = jsonPayload(result);
  assert.equal(payload.status, "blocked");
  assert.equal(payload.findings[0].check, "secrets");

  const env = fakeGitEnv(gitDir, "--diff-filter=ACMRT");
  result = cli(gitDir, ["precommit", "--json"], { env });
  payload = jsonPayload(result);
  assert.equal(payload.status, "advisory");
  assert.equal(payload.findings[0].check, "git");

  result = cli(missingGitDir, ["precommit", "--json"], {
    env: { ...process.env, PATH: "" },
  });
  payload = jsonPayload(result);
  assert.equal(payload.status, "advisory");
  assert.equal(payload.findings[0].check, "git");
  assert.match(
    payload.checks.find((check) => check.id === "staged-files").details.error,
    /git/i,
  );

  commitConfig(earlyDir, { protectedBranches: ["main", "master"] });
  writeFile(path.join(earlyDir, "assets", "raw.bin"), "fixture\n");
  run("git", ["add", "assets/raw.bin"], earlyDir);
  result = cli(earlyDir, ["precommit", "--json"]);
  payload = jsonPayload(result);
  assert.equal(payload.status, "advisory");
  assert.ok(payload.findings.some((finding) => finding.check === "branch"));
});

test("blocking secret-scan JSON distinguishes an unavailable scanner", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, {
    blockOnSecrets: true,
    protectedBranches: [],
    requireTests: false,
  });
  writeFile(path.join(tempDir, "src", "clean.txt"), "clean\n");
  run("git", ["add", "src/clean.txt"], tempDir);

  const result = cli(tempDir, ["precommit", "--json"], {
    env: fakeGitEnv(tempDir, "diff-tree --no-commit-id --no-renames -r -U0"),
  });
  const payload = jsonPayload(result);
  const secretCheck = payload.checks.find((check) => check.id === "secrets");

  assert.equal(result.status, 1);
  assert.equal(payload.status, "blocked");
  assert.equal(
    payload.summary,
    "Commit blocked because the secret scan was unavailable",
  );
  assert.equal(secretCheck.status, "failed");
  assert.equal(secretCheck.details.inspectionOutcome, "nonzero");
  assert.equal(payload.findings[0].check, "secrets");
  assert.equal(payload.findings[0].message, "Staged secret scan unavailable");
  assert.doesNotMatch(result.stdout, /possible secret staged/i);
});

test("prepush JSON keeps protected-branch advisories in every allowed outcome", (t) => {
  const disabledDir = createTempRepo();
  const noTestsDir = createTempRepo();
  const passingDir = createTempRepo();
  for (const dir of [disabledDir, noTestsDir, passingDir]) {
    t.after(() => cleanupTempRepo(dir));
  }

  commitConfig(disabledDir, { protectedBranches: ["main"] });
  let payload = jsonPayload(
    cli(disabledDir, ["prepush", "--json"], {
      input: pushInput(disabledDir),
    }),
  );
  assert.equal(payload.status, "advisory");
  assert.match(payload.findings[0].message, /protected branch/);

  commitConfig(noTestsDir, {
    advisePushTests: true,
    protectedBranches: ["main"],
  });
  writeFile(path.join(noTestsDir, "docs", "note.md"), "docs only\n");
  run("git", ["add", "docs/note.md"], noTestsDir);
  run("git", ["commit", "-m", "add docs"], noTestsDir);
  payload = jsonPayload(
    cli(noTestsDir, ["prepush", "--json"], {
      input: pushInput(noTestsDir),
    }),
  );
  assert.equal(payload.status, "advisory");
  assert.equal(payload.summary, "No tests to run before push");

  configureCustomPushRunner(passingDir, {});
  addPushedTestFixture(passingDir);
  setPrecommitConfig(passingDir, {
    advisePushTests: true,
    protectedBranches: ["main"],
    testCommand: ["node", "json-test-runner.mjs"],
  });
  payload = jsonPayload(
    cli(passingDir, ["prepush", "--json"], {
      input: pushInput(passingDir),
    }),
  );
  assert.equal(payload.status, "advisory");
  assert.equal(
    payload.summary,
    "All tests passed; push allowed with advisory findings",
  );
});

test("prepush JSON pluralizes a blocked multi-branch push", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  commitConfig(tempDir, {
    blockProtectedBranches: true,
    protectedBranches: ["main", "release"],
  });
  const mainRef = pushInput(tempDir).trim();
  const input = `${mainRef}\n${mainRef.replaceAll("main", "release")}\n`;
  const result = cli(tempDir, ["prepush", "--json"], { input });
  const payload = jsonPayload(result);

  assert.equal(result.status, 1);
  assert.equal(payload.status, "blocked");
  assert.equal(
    payload.checks.find((check) => check.id === "protected-branch").summary,
    "Protected push targets are blocked",
  );
  assert.match(payload.findings[0].message, /protected branches/);
});

test("JSON argument errors are machine-readable and unsupported commands fail clearly", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  let result = cli(tempDir, ["precommit", "--json", "--json"]);
  const payload = jsonPayload(result);
  assert.equal(result.status, 1);
  assert.equal(payload.status, "error");
  assert.equal(payload.diagnostics[0].code, "arguments.invalid");

  result = cli(tempDir, ["precommit", "--json=pretty"]);
  assert.equal(result.status, 1);
  assert.match(jsonPayload(result).diagnostics[0].message, /without a value/);

  result = cli(tempDir, ["doctor", "--json"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /only supported by 'precommit' and 'prepush'/);
});

test("prepush --json forwards Git arguments and keeps child output on stderr", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  configureCustomPushRunner(tempDir, { exit: 2 });
  addPushedTestFixture(tempDir);

  const result = cli(
    tempDir,
    ["prepush", "origin", "https://example.invalid/repo.git", "--json"],
    { input: pushInput(tempDir) },
  );
  const payload = jsonPayload(result);

  assert.equal(result.status, 0);
  assert.equal(payload.command, "prepush");
  assert.equal(payload.status, "advisory");
  assert.equal(
    payload.checks.find((check) => check.id === "push-tests").status,
    "advisory",
  );
  assert.doesNotMatch(result.stdout, /child (stdout|stderr) sentinel/);
  assert.match(result.stderr, /child stdout sentinel/);
  assert.match(result.stderr, /child stderr sentinel/);
});

test("prepush --json reports clean and blocking subprocess results", (t) => {
  const cleanDir = createTempRepo();
  const blockedDir = createTempRepo();
  t.after(() => cleanupTempRepo(cleanDir));
  t.after(() => cleanupTempRepo(blockedDir));

  configureCustomPushRunner(cleanDir, { exit: 0 });
  addPushedTestFixture(cleanDir);
  let result = cli(cleanDir, ["prepush", "--json"], {
    input: pushInput(cleanDir),
  });
  let payload = jsonPayload(result);
  assert.equal(payload.status, "clean");
  assert.equal(result.status, 0);

  configureCustomPushRunner(blockedDir, { blocking: true, exit: 2 });
  addPushedTestFixture(blockedDir);
  result = cli(blockedDir, ["prepush", "--json"], {
    input: pushInput(blockedDir),
  });
  payload = jsonPayload(result);
  assert.equal(result.status, 1);
  assert.equal(payload.status, "blocked");
  assert.equal(payload.findings.at(-1).severity, "error");
});

test("hookOutput does not change prepush JSON payloads", (t) => {
  const quietDir = createTempRepo();
  const normalDir = createTempRepo();
  t.after(() => cleanupTempRepo(quietDir));
  t.after(() => cleanupTempRepo(normalDir));

  configureCustomPushRunner(quietDir, {
    exit: 0,
    hookOutput: "problems-only",
  });
  configureCustomPushRunner(normalDir, { exit: 0, hookOutput: "normal" });
  addPushedTestFixture(quietDir);
  addPushedTestFixture(normalDir);

  const quiet = jsonPayload(
    cli(quietDir, ["prepush", "--json"], { input: pushInput(quietDir) }),
  );
  const normal = jsonPayload(
    cli(normalDir, ["prepush", "--json"], { input: pushInput(normalDir) }),
  );

  assert.deepEqual(quiet, normal);
});

test("prepush JSON covers disabled mode, argument errors, and node test output", (t) => {
  const disabledDir = createTempRepo();
  const nodeDir = createTempRepo();
  t.after(() => cleanupTempRepo(disabledDir));
  t.after(() => cleanupTempRepo(nodeDir));

  setPrecommitConfig(disabledDir, { protectedBranches: [] });
  let result = cli(disabledDir, ["prepush", "--json"]);
  let payload = jsonPayload(result);
  assert.equal(payload.mode, "disabled");
  assert.equal(payload.status, "skipped");

  result = cli(disabledDir, ["prepush", "one", "two", "three", "--json"]);
  payload = jsonPayload(result);
  assert.equal(result.status, 1);
  assert.equal(payload.status, "error");

  commitConfig(nodeDir, {
    advisePushTests: true,
    protectedBranches: [],
  });
  addPushedTestFixture(nodeDir);
  result = cli(nodeDir, ["prepush", "--json"], {
    input: pushInput(nodeDir),
  });
  payload = jsonPayload(result);
  assert.equal(payload.status, "clean");
  assert.equal(
    payload.checks.find((check) => check.id === "push-tests").details.summary
      .failed,
    0,
  );
  assert.doesNotMatch(result.stdout, /✔|ℹ tests/);
  assert.match(result.stderr, /widget\.test\.mjs/);
});

test("prepush JSON covers configuration, policy, and failure edge outcomes", (t) => {
  const configDir = createTempRepo();
  const guardDir = createTempRepo();
  const advisoryDiffDir = createTempRepo();
  const blockingDiffDir = createTempRepo();
  const noTestsDir = createTempRepo();
  const advisoryRunnerDir = createTempRepo();
  const blockingRunnerDir = createTempRepo();
  for (const dir of [
    configDir,
    guardDir,
    advisoryDiffDir,
    blockingDiffDir,
    noTestsDir,
    advisoryRunnerDir,
    blockingRunnerDir,
  ]) {
    t.after(() => cleanupTempRepo(dir));
  }

  commitConfig(configDir, {
    unknownMode: true,
    requireTests: "nope",
    commitMessage: { blockOnFailure: true },
    advisePushTests: true,
    blockPushOnTestFailure: true,
    protectedBranches: [],
  });
  let result = cli(configDir, ["prepush", "--json"], {
    input: pushInput(configDir),
  });
  let payload = jsonPayload(result);
  assert.deepEqual(
    payload.diagnostics.map(({ code }) => code),
    [
      "config.unknown-keys",
      "config.invalid-values",
      "config.ineffective-value",
      "config.push-mode-conflict",
    ],
  );

  commitConfig(guardDir, {
    blockProtectedBranches: true,
    protectedBranches: ["main"],
  });
  result = cli(guardDir, ["prepush", "--json"], {
    input: pushInput(guardDir),
  });
  payload = jsonPayload(result);
  assert.equal(result.status, 1);
  assert.equal(payload.status, "blocked");
  assert.equal(payload.findings[0].check, "branch");

  commitConfig(advisoryDiffDir, {
    advisePushTests: true,
    protectedBranches: [],
  });
  result = cli(advisoryDiffDir, ["prepush", "--json"], {
    input: pushInput(advisoryDiffDir),
    env: fakeGitEnv(advisoryDiffDir, "--name-status -z"),
  });
  payload = jsonPayload(result);
  assert.equal(result.status, 0);
  assert.equal(payload.status, "advisory");
  assert.equal(payload.findings[0].check, "git");

  commitConfig(blockingDiffDir, {
    blockPushOnTestFailure: true,
    protectedBranches: [],
  });
  result = cli(blockingDiffDir, ["prepush", "--json"], {
    input: pushInput(blockingDiffDir),
    env: fakeGitEnv(blockingDiffDir, "--name-status -z"),
  });
  payload = jsonPayload(result);
  assert.equal(result.status, 1);
  assert.equal(payload.status, "blocked");
  assert.equal(payload.findings[0].check, "git");

  commitConfig(noTestsDir, {
    advisePushTests: true,
    protectedBranches: [],
  });
  writeFile(path.join(noTestsDir, "docs", "note.md"), "docs only\n");
  run("git", ["add", "docs/note.md"], noTestsDir);
  run("git", ["commit", "-m", "add docs"], noTestsDir);
  result = cli(noTestsDir, ["prepush", "--json"], {
    input: pushInput(noTestsDir),
  });
  payload = jsonPayload(result);
  assert.equal(result.status, 0);
  assert.equal(payload.status, "skipped");

  commitConfig(advisoryRunnerDir, {
    advisePushTests: true,
    protectedBranches: [],
    testCommand: ["definitely-not-installed-json-runner"],
  });
  addPushedTestFixture(advisoryRunnerDir);
  result = cli(advisoryRunnerDir, ["prepush", "--json"], {
    input: pushInput(advisoryRunnerDir),
  });
  payload = jsonPayload(result);
  assert.equal(result.status, 0);
  assert.equal(payload.status, "advisory");
  assert.equal(payload.findings.at(-1).check, "tests");

  commitConfig(blockingRunnerDir, {
    blockPushOnTestFailure: true,
    protectedBranches: [],
    testCommand: ["definitely-not-installed-json-runner"],
  });
  addPushedTestFixture(blockingRunnerDir);
  result = cli(blockingRunnerDir, ["prepush", "--json"], {
    input: pushInput(blockingRunnerDir),
  });
  payload = jsonPayload(result);
  assert.equal(result.status, 1);
  assert.equal(payload.status, "blocked");
  assert.equal(payload.findings.at(-1).check, "tests");
});

test("the published schema and documentation stay version-aligned", () => {
  const schema = JSON.parse(
    readFile(path.resolve("."), "docs/json-output.schema.json"),
  );
  assert.equal(
    schema.properties.schemaVersion.const,
    JSON_OUTPUT_SCHEMA_VERSION,
  );
  assert.match(
    fs.readFileSync(path.resolve("docs/json-output.md"), "utf8"),
    new RegExp(`schemaVersion.*${JSON_OUTPUT_SCHEMA_VERSION}`, "s"),
  );
});
