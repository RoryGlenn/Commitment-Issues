// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  classifyHook,
  composePrepareRepair,
  detectHookManagers,
  effectiveHooksDir,
  gitWorkTreeState,
  gitHooksDir,
  hookBody,
  hookCommand,
  hookInvocation,
  hookManagerInstallCommand,
  hookManagerSnippets,
  hookNamesForConfig,
  hooksDisabled,
  hooksPathConfig,
  hooksPathConfigState,
  isHuskyDirectHooksPath,
  isHuskyHooksPath,
  inspectHookManager,
  inspectHookManagerForCleanup,
  inspectHookManagerRunner,
  inspectPrepareRepairScript,
  legacyHuskyDirectoryState,
  legacyHuskyWiringPaths,
  leftoverHuskyHooks,
  prepareRepairCommand,
  prepareRepairCommands,
  recognizedPrepareRepairCommands,
  removeLegacyHuskyWiring,
  writeHook,
} from "../scripts/lib/hooks.mjs";
import {
  cleanupTempRepo,
  createTempRepo,
  fakeGitEnv,
  REAL_GIT,
  run,
  writeCrossPlatformShim,
} from "./helpers/temp-repo.mjs";
import {
  HUSKY_V8_RUNTIME,
  HUSKY_V9_RUNTIME,
  HUSKY_V9_RUNTIME_VARIANTS,
  lefthookRunner,
  preCommitRunner,
} from "./helpers/hook-manager-fixtures.mjs";

function quoteShellWord(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function localHookInvocation(name) {
  const command = `node_modules/.bin/commitment-issues hook ${
    name === "pre-commit"
      ? "precommit"
      : name === "pre-push"
        ? 'prepush "$@"'
        : 'commit-msg "$1"'
  }`;
  return command;
}

function prepareRepairSource(command) {
  const match = /^node -e "(?<source>[^"]+)"$/u.exec(command);
  assert.ok(match?.groups?.source, `unexpected prepare command: ${command}`);
  return match.groups.source;
}

test("prepare repair commands invoke only the installed project package", (t) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "prepare repair $() ` & "),
  );
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const standalone = prepareRepairCommand();
  const commands = prepareRepairCommands();
  assert.deepEqual(commands, [
    standalone,
    prepareRepairCommand("husky"),
    prepareRepairCommand("lefthook"),
    prepareRepairCommand("pre-commit"),
  ]);
  assert.equal(new Set(commands).size, commands.length);
  assert.match(standalone, /node_modules\/commitment-issues/u);
  assert.doesNotMatch(
    standalone,
    /\bnpx\b|\bnpm\b|\bpnpm\b|\byarn\b|\bbunx?\b/u,
  );
  assert.throws(
    () => prepareRepairCommand("unknown"),
    /Unsupported hook manager: unknown/u,
  );

  const absent = run(
    process.execPath,
    ["-e", prepareRepairSource(standalone)],
    tempDir,
  );
  assert.equal(absent.status, 0, absent.stderr);
  assert.equal(absent.stdout, "");
  assert.equal(absent.stderr, "");

  const packageDir = path.join(tempDir, "node_modules", "commitment-issues");
  const cliDir = path.join(packageDir, "scripts");
  const invocationLog = path.join(tempDir, "repair-argv.json");
  fs.mkdirSync(cliDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), "{}\n");
  fs.writeFileSync(
    path.join(cliDir, "cli.mjs"),
    "import fs from 'node:fs';\n" +
      "fs.writeFileSync(process.env.PREPARE_REPAIR_LOG, JSON.stringify(process.argv.slice(2)));\n",
  );

  const available = run(
    process.execPath,
    ["-e", prepareRepairSource(prepareRepairCommand("lefthook"))],
    tempDir,
    {
      env: { ...process.env, PREPARE_REPAIR_LOG: invocationLog },
    },
  );
  assert.equal(available.status, 0, available.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(invocationLog, "utf8")), [
    "doctor",
    "--quiet",
    "--integration=lefthook",
  ]);

  fs.rmSync(path.join(cliDir, "cli.mjs"));
  const corrupt = run(
    process.execPath,
    ["-e", prepareRepairSource(standalone)],
    tempDir,
  );
  assert.notEqual(corrupt.status, 0);
  assert.match(corrupt.stderr, /ERR_MODULE_NOT_FOUND/u);
});

test("prepare repair composition preserves safe project syntax and ownership", () => {
  const repair = prepareRepairCommand();
  const cases = [
    {
      project: "node --version",
      expected: `node --version && ${repair}`,
      composition: "and",
    },
    {
      project: "node --version \t\n",
      expected: `node --version && ${repair} \t\n`,
      composition: "and",
    },
    {
      project: "node --version; \n",
      expected: `node --version && ${repair}; \n`,
      composition: "semicolon",
    },
    {
      project: "node --version;\r\n",
      expected: `node --version && ${repair};\r\n`,
      composition: "semicolon",
    },
    {
      project: "node --version &\t",
      expected: `node --version & ${repair}\t`,
      composition: "background",
    },
    {
      project: `node -e "console.log('; && | &')"`,
      expected: `node -e "console.log('; && | &')" && ${repair}`,
      composition: "and",
    },
    {
      project: `node -e "console.log(\\"safe\\")"`,
      expected: `node -e "console.log(\\"safe\\")" && ${repair}`,
      composition: "and",
    },
    {
      project: "echo 'single ; && | & <<EOF'",
      expected: `echo 'single ; && | & <<EOF' && ${repair}`,
      composition: "and",
    },
    {
      project: "echo `printf safe`",
      expected: `echo \`printf safe\` && ${repair}`,
      composition: "and",
    },
    {
      project: "echo escaped\\ value",
      expected: `echo escaped\\ value && ${repair}`,
      composition: "and",
    },
    {
      project: "echo escaped\\#value",
      expected: `echo escaped\\#value && ${repair}`,
      composition: "and",
    },
    {
      project: "# first line\nnode --version",
      expected: `# first line\nnode --version && ${repair}`,
      composition: "and",
    },
    {
      project: "node --version;# second line\nnode --version",
      expected: `node --version;# second line\nnode --version && ${repair}`,
      composition: "and",
    },
    {
      project: "(node --version)",
      expected: `(node --version) && ${repair}`,
      composition: "and",
    },
    {
      project: "node --version;\nnode --version\n",
      expected: `node --version;\nnode --version && ${repair}\n`,
      composition: "and",
    },
  ];

  for (const fixture of cases) {
    const composed = composePrepareRepair(fixture.project, repair);
    assert.deepEqual(composed, {
      status: "composed",
      script: fixture.expected,
      composition: fixture.composition,
    });
    assert.deepEqual(inspectPrepareRepairScript(composed.script), {
      status: "owned",
      command: repair,
      projectScript: fixture.project,
      composition: fixture.composition,
      reason: null,
    });
  }

  assert.deepEqual(composePrepareRepair(" \n", repair), {
    status: "composed",
    script: repair,
    composition: "standalone",
  });
  assert.deepEqual(composePrepareRepair(42, repair), {
    status: "unsafe",
    script: null,
    composition: null,
    reason: "scripts.prepare is not a string",
  });
});

test("prepare repair analysis refuses incomplete or ambiguous shell edits", () => {
  const repair = prepareRepairCommand();
  for (const project of [
    "node --version &&",
    "node --version ||",
    "node --version |",
    "node --version ;;",
    'node -e "unterminated',
    "node --version \\",
    "node --version # trailing comment",
    "(node --version)# trailing comment",
    "(node --version",
    "node --version)",
    "cat <<EOF\ncontent\nEOF",
    "cat <<-EOF\n\tcontent\nEOF",
    "cat <<< content",
  ]) {
    const result = composePrepareRepair(project, repair);
    assert.equal(result.status, "unsafe", project);
    assert.equal(result.script, null);
    assert.match(result.reason, /scripts\.prepare/u);
  }

  const historicalBroken = `node --version; && ${repair}`;
  assert.deepEqual(inspectPrepareRepairScript(historicalBroken), {
    status: "invalid",
    command: repair,
    projectScript: "node --version;",
    composition: "and",
    reason:
      "the historical repair suffix follows a trailing semicolon operator",
  });
  assert.deepEqual(
    inspectPrepareRepairScript(`node --version & && ${repair}`),
    {
      status: "invalid",
      command: repair,
      projectScript: "node --version &",
      composition: "and",
      reason:
        "the historical repair suffix follows a trailing background operator",
    },
  );
  assert.deepEqual(inspectPrepareRepairScript(` && ${repair}`), {
    status: "invalid",
    command: repair,
    projectScript: "",
    composition: "and",
    reason: "scripts.prepare has no project command to preserve",
  });
  assert.equal(
    inspectPrepareRepairScript(`node --version) && ${repair};`).status,
    "invalid",
  );
  assert.equal(
    inspectPrepareRepairScript(`node --version)& ${repair}`).status,
    "invalid",
  );

  const displaced = `node --version && ${repair} && node --version`;
  assert.deepEqual(inspectPrepareRepairScript(displaced), {
    status: "ambiguous",
    command: repair,
    projectScript: null,
    composition: null,
    reason:
      "a recognized Commitment Issues repair command is not in an exact generated terminal position",
  });
  assert.equal(
    inspectPrepareRepairScript(
      `${repair} && node --version && ${prepareRepairCommand("husky")}`,
    ).status,
    "ambiguous",
  );
  for (const controlFlow of [
    `if ${repair}; then node --version; fi`,
    `if node --version; then ${repair}; fi`,
    `if false; then node --version; elif ${repair}; then :; fi`,
    `if false; then node --version; else ${repair}; fi`,
    `while ${repair}; do :; done`,
    `until false; do ${repair}; done`,
    `{ ${repair}; }`,
    `case x in x) ${repair} ;; esac`,
    `! ${repair}`,
    `command ${repair}`,
  ]) {
    assert.equal(
      inspectPrepareRepairScript(controlFlow).status,
      "ambiguous",
      controlFlow,
    );
  }

  for (const projectMention of [
    'echo "commitment-issues doctor --quiet"',
    "echo 'commitment-issues doctor --quiet'",
    "echo `commitment-issues doctor --quiet`",
    "echo commitment-issues doctor --quiet",
    "echo commitment-issues\\ doctor --quiet",
    "commitment-issues doctor --quietly",
    `echo if ${repair}`,
  ]) {
    assert.deepEqual(inspectPrepareRepairScript(projectMention), {
      status: "project",
      command: null,
      projectScript: projectMention,
      composition: null,
      reason: null,
    });
  }
  assert.equal(inspectPrepareRepairScript(`(${repair})`).status, "ambiguous");
  assert.deepEqual(inspectPrepareRepairScript(42), {
    status: "ambiguous",
    command: null,
    projectScript: null,
    composition: null,
    reason: "scripts.prepare is not a string",
  });

  assert.deepEqual(recognizedPrepareRepairCommands(), [
    ...prepareRepairCommands(),
    "commitment-issues doctor --quiet",
    "commitment-issues doctor --quiet --integration=husky",
    "commitment-issues doctor --quiet --integration=lefthook",
    "commitment-issues doctor --quiet --integration=pre-commit",
  ]);
});

test("Lefthook files producer emits only the fixed package sentinel", (t) => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "lefthook-files $() ` hostile "),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = run(
    process.execPath,
    [path.resolve("scripts/lefthook-files.mjs"), "--ignored", "$(touch nope)"],
    dir,
    { env: { ...process.env, LEFTHOOK_FILE: "repository-controlled" } },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "node_modules/commitment-issues/package.json\n");
  assert.equal(result.stderr, "");
  assert.deepEqual(fs.readdirSync(dir), []);
});

for (const name of ["pre-commit", "pre-push"]) {
  const localInvocation = localHookInvocation(name);
  const expectedCommand = hookInvocation(name);
  const globalInvocation =
    name === "pre-commit"
      ? "commitment-issues precommit"
      : 'commitment-issues prepush "$@"';

  test(`classifyHook recognizes active ${name} hook states`, (t) => {
    const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-classify-"));
    t.after(() => fs.rmSync(hooksDir, { recursive: true, force: true }));
    const hookPath = path.join(hooksDir, name);

    assert.equal(classifyHook(hooksDir, name), "missing");

    writeHook(hooksDir, name);
    assert.equal(classifyHook(hooksDir, name), "wired");
    assert.equal(fs.readFileSync(hookPath, "utf8"), hookBody(name));

    const body = `#!/bin/sh\n${expectedCommand}\necho still-custom\n`;
    fs.writeFileSync(hookPath, body);
    fs.chmodSync(hookPath, 0o755);
    assert.equal(classifyHook(hooksDir, name), "custom-with-command");
    assert.equal(fs.readFileSync(hookPath, "utf8"), body);

    for (const command of [
      `${localInvocation} || exit $?`,
      `command ${localInvocation} || exit $?`,
      `exec ${localInvocation}`,
    ]) {
      fs.writeFileSync(hookPath, `#!/bin/sh\n${command}\n`);
      fs.chmodSync(hookPath, 0o755);
      assert.equal(classifyHook(hooksDir, name), "custom-with-legacy-command");
    }

    const documentedBody = [
      "#!/bin/sh",
      "# Keep the guarded integration first so its exit status is preserved.",
      expectedCommand,
      "echo still-custom",
      "",
    ].join("\n");
    fs.writeFileSync(hookPath, documentedBody);
    fs.chmodSync(hookPath, 0o755);
    assert.equal(classifyHook(hooksDir, name), "custom-with-command");
    assert.equal(fs.readFileSync(hookPath, "utf8"), documentedBody);

    const legacyLocalInvocation =
      name === "pre-commit"
        ? "node_modules/.bin/commitment-issues precommit"
        : 'node_modules/.bin/commitment-issues prepush "$@"';
    fs.writeFileSync(
      hookPath,
      `#!/bin/sh\n${legacyLocalInvocation} || exit $?\n`,
    );
    fs.chmodSync(hookPath, 0o755);
    assert.equal(classifyHook(hooksDir, name), "custom-with-legacy-command");

    const malformedHeredoc = `#!/bin/sh\ncat << ;\n${expectedCommand}\n`;
    fs.writeFileSync(hookPath, malformedHeredoc);
    fs.chmodSync(hookPath, 0o755);
    assert.equal(classifyHook(hooksDir, name), "custom-without-command");
  });

  test(`classifyHook rejects inert ${name} command mentions`, (t) => {
    const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-classify-"));
    t.after(() => fs.rmSync(hooksDir, { recursive: true, force: true }));
    const hookPath = path.join(hooksDir, name);
    const inertBodies = [
      `#!/bin/sh\n# ${expectedCommand}\n`,
      `#!/bin/sh\necho ${expectedCommand}\n`,
      `#!/bin/sh\nprintf '%s\\n' '${expectedCommand}'\n`,
      `#!/bin/sh\nexample="${expectedCommand}"\n`,
      `#!/bin/sh\n"${expectedCommand}"\n`,
      ["#!/bin/sh", "cat <<'DOC'", expectedCommand, "DOC", ""].join("\n"),
      ["#!/bin/sh", "example='", expectedCommand, "'", ""].join("\n"),
      ["#!/bin/sh", "echo \\", expectedCommand, ""].join("\n"),
      ["#!/bin/sh", "printf '%s' \\", "ignored", expectedCommand, ""].join(
        "\n",
      ),
      ["#!/bin/sh", "printf '%s' ignored\\ word", expectedCommand, ""].join(
        "\n",
      ),
      ["#!/bin/sh", "echo word#not-a-comment", ""].join("\n"),
      ["#!/bin/sh", "cat <<-DOC", `\t${expectedCommand}`, "\tDOC", ""].join(
        "\n",
      ),
      ["#!/bin/sh", "cat <<  DOC", expectedCommand, "DOC", ""].join("\n"),
      ["#!/bin/sh", 'cat <<"D\\OC"', expectedCommand, "DOC", ""].join("\n"),
      ["#!/bin/sh", "cat <<D\\OC", expectedCommand, "DOC", ""].join("\n"),
      ["#!/bin/sh", "cat <<DOC; echo ignored", expectedCommand, "DOC", ""].join(
        "\n",
      ),
      ["#!/bin/sh", "false &&", expectedCommand, ""].join("\n"),
      ["#!/bin/sh", "true ||", expectedCommand, ""].join("\n"),
      ["#!/bin/sh", "value=$(", expectedCommand, ")", ""].join("\n"),
      ["#!/bin/bash", "cat <(", expectedCommand, ")", ""].join("\n"),
      ["#!/bin/sh", "true; if false; then", expectedCommand, "fi", ""].join(
        "\n",
      ),
      ["#!/bin/sh", "check() { # helper", expectedCommand, "}", ""].join("\n"),
      ["#!/bin/sh", "check()", "{", expectedCommand, "}", ""].join("\n"),
      [
        "#!/bin/sh",
        "if false; then",
        "{",
        ":",
        "}",
        expectedCommand,
        "fi",
        "",
      ].join("\n"),
      ["#!/bin/sh", "set -n", expectedCommand, ""].join("\n"),
      ["#!/bin/sh", "set -en;", expectedCommand, ""].join("\n"),
      ["#!/bin/sh", "set -e -n", expectedCommand, ""].join("\n"),
      ["#!/bin/bash", "set -o noexec", expectedCommand, ""].join("\n"),
      ["#!/bin/bash", "set -o noexec;", expectedCommand, ""].join("\n"),
      ["#!/bin/sh", "{", "exit 0", "}", expectedCommand, ""].join("\n"),
      ["#!/bin/sh", "{", "set -n", "}", expectedCommand, ""].join("\n"),
      ["#!/bin/sh", "false && {", expectedCommand, "}", ""].join("\n"),
      ["#!/bin/sh", "true || {", expectedCommand, "}", ""].join("\n"),
      ["#!/bin/sh", "false &&", "{", expectedCommand, "}", ""].join("\n"),
      ["#!/bin/sh", "{", expectedCommand, "} &", ""].join("\n"),
      ["#!/bin/sh", "{", expectedCommand, "} | true", ""].join("\n"),
      ["#!/bin/sh", "echo existing", expectedCommand, ""].join("\n"),
      `#!/bin/sh\ncommand ${globalInvocation} || exit $?\n`,
      `#!/bin/sh\nexec ${globalInvocation}\n`,
      ["#!/bin/sh", "exit;", expectedCommand, ""].join("\n"),
      ["#!/bin/false", expectedCommand, ""].join("\n"),
    ];

    for (const body of inertBodies) {
      fs.writeFileSync(hookPath, body);
      fs.chmodSync(hookPath, 0o755);
      assert.equal(
        classifyHook(hooksDir, name),
        "custom-without-command",
        `expected inert hook body:\n${body}`,
      );
      assert.equal(fs.readFileSync(hookPath, "utf8"), body);
    }

    const displacedCommand = `#!/bin/sh\necho existing\n${expectedCommand}\n`;
    fs.writeFileSync(hookPath, displacedCommand);
    fs.chmodSync(hookPath, 0o755);
    assert.equal(
      classifyHook(hooksDir, name, {
        requireExecutable: false,
        recognizeLegacyCommand: true,
      }),
      "custom-with-command",
    );

    const crossStageName = name === "pre-commit" ? "pre-push" : "pre-commit";
    fs.writeFileSync(
      hookPath,
      `#!/bin/sh\necho existing\n${hookInvocation(crossStageName)}\n`,
    );
    assert.equal(
      classifyHook(hooksDir, name, {
        requireExecutable: false,
        recognizeLegacyCommand: true,
      }),
      "custom-with-command",
    );

    for (const body of [
      `#!/bin/sh\n# ${expectedCommand}\n`,
      `#!/bin/sh\nprintf '%s\\n' '${expectedCommand}'\n`,
      ["#!/bin/sh", "cat <<'DOC'", expectedCommand, "DOC", ""].join("\n"),
    ]) {
      fs.writeFileSync(hookPath, body);
      fs.chmodSync(hookPath, 0o755);
      assert.equal(
        classifyHook(hooksDir, name, {
          requireExecutable: false,
          recognizeLegacyCommand: true,
        }),
        "custom-without-command",
      );
    }

    for (const body of [
      `#!/bin/sh\ncommand ${globalInvocation} || exit $?\n`,
      `#!/bin/sh\nexec ${globalInvocation}\n`,
    ]) {
      fs.writeFileSync(hookPath, body);
      fs.chmodSync(hookPath, 0o755);
      assert.equal(
        classifyHook(hooksDir, name, {
          requireExecutable: false,
          recognizeLegacyCommand: true,
        }),
        "custom-with-command",
      );
    }
  });

  test(
    `classifyHook rejects a non-executable ${name} hook on POSIX`,
    { skip: process.platform === "win32" },
    (t) => {
      const hooksDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "hooks-classify-"),
      );
      t.after(() => fs.rmSync(hooksDir, { recursive: true, force: true }));
      const hookPath = path.join(hooksDir, name);
      const body = `#!/bin/sh\n${expectedCommand}\n`;

      fs.writeFileSync(hookPath, body, { mode: 0o644 });
      assert.equal(classifyHook(hooksDir, name), "non-executable");
      assert.equal(fs.readFileSync(hookPath, "utf8"), body);
      assert.equal(fs.statSync(hookPath).mode & 0o111, 0);
    },
  );
}

test(
  "hook classification rejects CRLF wrappers that POSIX Git cannot launch",
  { skip: process.platform === "win32" },
  (t) => {
    const dir = createTempRepo();
    t.after(() => cleanupTempRepo(dir));
    const hooksDir = path.join(dir, ".git", "hooks");
    const hookPath = path.join(hooksDir, "pre-commit");
    const body = [
      "#!/usr/bin/env sh",
      "node_modules/.bin/commitment-issues hook precommit || exit $?",
      "",
    ].join("\r\n");
    fs.writeFileSync(hookPath, body, { mode: 0o755 });

    assert.equal(
      classifyHook(hooksDir, "pre-commit"),
      "custom-without-command",
    );
    const before = run(REAL_GIT, ["rev-parse", "HEAD"], dir).stdout.trim();
    const commit = run(
      REAL_GIT,
      ["commit", "--allow-empty", "-m", "exercise CRLF hook"],
      dir,
    );
    assert.notEqual(commit.status, 0);
    assert.equal(
      run(REAL_GIT, ["rev-parse", "HEAD"], dir).stdout.trim(),
      before,
    );
  },
);

test(
  "hook classification uses effective execute access instead of mode bits",
  { skip: process.platform === "win32" },
  (t) => {
    const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-access-"));
    t.after(() => fs.rmSync(hooksDir, { recursive: true, force: true }));
    const hookPath = path.join(hooksDir, "pre-commit");
    fs.writeFileSync(hookPath, hookBody("pre-commit"), { mode: 0o755 });
    const originalAccess = fs.accessSync;
    let errorCode = "EACCES";
    t.mock.method(fs, "accessSync", (filePath, ...args) => {
      if (filePath === hookPath) {
        throw Object.assign(new Error("injected execute-access failure"), {
          code: errorCode,
        });
      }
      return originalAccess(filePath, ...args);
    });

    assert.equal(classifyHook(hooksDir, "pre-commit"), "non-executable");
    errorCode = "EIO";
    assert.equal(classifyHook(hooksDir, "pre-commit"), "uninspectable");
  },
);

test("hook classification rejects shell bodies above the inspection limit", (t) => {
  const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-oversized-"));
  t.after(() => fs.rmSync(hooksDir, { recursive: true, force: true }));
  const hookPath = path.join(hooksDir, "pre-commit");
  const body = [
    "#!/bin/sh",
    "node_modules/.bin/commitment-issues precommit || exit $?",
    `# ${"x".repeat(128 * 1024)}`,
    "",
  ].join("\n");
  fs.writeFileSync(hookPath, body, { mode: 0o755 });

  assert.equal(classifyHook(hooksDir, "pre-commit"), "custom-without-command");
  assert.equal(fs.readFileSync(hookPath, "utf8"), body);
});

test(
  "hook syntax validation never executes PATH-controlled shell shims",
  { skip: process.platform === "win32" },
  (t) => {
    const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-shell-path-"));
    const binDir = path.join(hooksDir, "bin");
    const marker = path.join(hooksDir, "executed");
    fs.mkdirSync(binDir);
    t.after(() => fs.rmSync(hooksDir, { recursive: true, force: true }));
    for (const name of ["sh", "bash"]) {
      fs.writeFileSync(
        path.join(binDir, name),
        `#!/bin/sh\nprintf unsafe > "${marker}"\nexit 0\n`,
        { mode: 0o755 },
      );
    }
    const hookPath = path.join(hooksDir, "pre-commit");
    fs.writeFileSync(
      hookPath,
      `#!/usr/bin/env sh\n${hookInvocation("pre-commit")}\n`,
      { mode: 0o755 },
    );
    const originalPath = process.env.PATH;
    process.env.PATH = binDir;
    try {
      assert.equal(classifyHook(hooksDir, "pre-commit"), "custom-with-command");
    } finally {
      process.env.PATH = originalPath;
    }
    assert.equal(fs.existsSync(marker), false);
  },
);

test(
  "Git-for-Windows shell discovery requires one regular bundled shell",
  { skip: process.platform === "win32" },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hook-git-shell-"));
    const hooksDir = path.join(root, "hooks");
    const fakeBin = path.join(root, "fake-bin");
    const execPath = path.join(root, "git", "mingw64", "libexec", "git-core");
    const usrBin = path.join(root, "git", "usr", "bin");
    const fallbackBin = path.join(root, "git", "bin");
    fs.mkdirSync(hooksDir);
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(execPath, { recursive: true });
    fs.mkdirSync(usrBin, { recursive: true });
    fs.mkdirSync(fallbackBin, { recursive: true });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const fakeGit = path.join(fakeBin, "git");
    fs.writeFileSync(
      fakeGit,
      `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(execPath)}\n`,
      { mode: 0o755 },
    );
    const hookPath = path.join(hooksDir, "pre-commit");
    fs.writeFileSync(hookPath, `#!/bin/sh\n${hookInvocation("pre-commit")}\n`, {
      mode: 0o755,
    });

    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    const originalPath = process.env.PATH;
    Object.defineProperty(process, "platform", {
      configurable: true,
      enumerable: true,
      value: "win32",
    });
    process.env.PATH = fakeBin;
    t.after(() => {
      Object.defineProperty(process, "platform", platform);
      process.env.PATH = originalPath;
    });

    const writeBundledShell = (destination) => {
      fs.writeFileSync(destination, '#!/bin/sh\nexec /bin/sh "$@"\n', {
        mode: 0o755,
      });
    };
    writeBundledShell(path.join(usrBin, "sh.exe"));
    assert.equal(classifyHook(hooksDir, "pre-commit"), "custom-with-command");

    fs.writeFileSync(
      hookPath,
      `#!/bin/sh\r\n${hookInvocation("pre-commit")}\r\n`,
      { mode: 0o755 },
    );
    assert.equal(classifyHook(hooksDir, "pre-commit"), "custom-with-command");

    fs.rmSync(path.join(usrBin, "sh.exe"));
    writeBundledShell(path.join(fallbackBin, "sh.exe"));
    assert.equal(classifyHook(hooksDir, "pre-commit"), "custom-with-command");

    fs.rmSync(path.join(fallbackBin, "sh.exe"));
    assert.equal(
      classifyHook(hooksDir, "pre-commit"),
      "custom-without-command",
    );

    fs.writeFileSync(fakeGit, "#!/bin/sh\nprintf 'one\\ntwo\\n'\n", {
      mode: 0o755,
    });
    assert.equal(
      classifyHook(hooksDir, "pre-commit"),
      "custom-without-command",
    );

    fs.writeFileSync(fakeGit, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    assert.equal(
      classifyHook(hooksDir, "pre-commit"),
      "custom-without-command",
    );

    fs.rmSync(fakeGit);
    assert.equal(
      classifyHook(hooksDir, "pre-commit"),
      "custom-without-command",
    );

    fs.writeFileSync(
      fakeGit,
      `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(execPath)}\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(usrBin, "bash.exe"),
      '#!/bin/sh\nexec /bin/bash "$@"\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(
      hookPath,
      `#!/bin/bash\n${hookInvocation("pre-commit")}\n`,
      { mode: 0o755 },
    );
    assert.equal(classifyHook(hooksDir, "pre-commit"), "custom-with-command");
  },
);

test(
  "manager runtime inspection models Windows executable paths statically",
  { skip: process.platform === "win32" },
  (t) => {
    const dir = createTempRepo();
    const runtimeBin = path.join(dir, ".windows-runtime-bin");
    const hooksDir = path.join(dir, ".git", "hooks");
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    const originalPath = process.env.PATH;
    const hadLefthookBin = Object.hasOwn(process.env, "LEFTHOOK_BIN");
    const originalLefthookBin = process.env.LEFTHOOK_BIN;
    t.after(() => cleanupTempRepo(dir));
    t.after(() => {
      Object.defineProperty(process, "platform", platform);
      process.env.PATH = originalPath;
      if (hadLefthookBin) process.env.LEFTHOOK_BIN = originalLefthookBin;
      else delete process.env.LEFTHOOK_BIN;
    });

    fs.rmSync(path.join(dir, "node_modules"), { recursive: true, force: true });
    fs.mkdirSync(runtimeBin);
    fs.symlinkSync(REAL_GIT, path.join(runtimeBin, "git"));
    const packagedLefthook = path.join(
      dir,
      "node_modules",
      `lefthook-windows-${process.arch}`,
      "bin",
      "lefthook.exe",
    );
    fs.mkdirSync(path.dirname(packagedLefthook), { recursive: true });
    fs.copyFileSync("/bin/sh", packagedLefthook);
    fs.chmodSync(packagedLefthook, 0o755);
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      lefthookRunner("pre-commit", { windows: true }).replaceAll("\n", "\r\n"),
      { mode: 0o755 },
    );

    Object.defineProperty(process, "platform", {
      configurable: true,
      enumerable: true,
      value: "win32",
    });
    process.env.PATH = runtimeBin;
    assert.equal(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
      "wired",
    );

    const canonicalWindows = lefthookRunner("pre-commit", { windows: true });
    assert.equal(canonicalWindows.trimEnd().split("\n").length, 74);
    for (const foreignWindows of [
      canonicalWindows.replace(
        "  elif lefthook.exe -h >/dev/null 2>&1",
        "  elif lefthook.cmd -h >/dev/null 2>&1",
      ),
      canonicalWindows.replace(
        '  elif lefthook.bat -h >/dev/null 2>&1\n  then\n    lefthook.bat "$@"\n',
        "",
      ),
      canonicalWindows.replace(
        'call_lefthook run "pre-commit" "$@"',
        'call_lefthook run "pre-push" "$@"',
      ),
      canonicalWindows.replace(
        'call_lefthook run "pre-commit" "$@"',
        'call_lefthook run "pre-commit" "$@" || true',
      ),
    ]) {
      fs.writeFileSync(path.join(hooksDir, "pre-commit"), foreignWindows, {
        mode: 0o755,
      });
      assert.equal(
        inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
        "foreign",
        foreignWindows,
      );
    }

    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      lefthookRunner("pre-commit", { windows: true }).replaceAll("\n", "\r"),
      { mode: 0o755 },
    );
    assert.equal(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
      "foreign",
    );
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      lefthookRunner("pre-commit", { windows: true }).replaceAll("\n", "\r\n"),
      { mode: 0o755 },
    );

    fs.rmSync(packagedLefthook);
    for (const runtimeName of ["lefthook.exe", "lefthook.bat"]) {
      const runtimePath = path.join(runtimeBin, runtimeName);
      fs.copyFileSync("/bin/sh", runtimePath);
      fs.chmodSync(runtimePath, 0o755);
      assert.equal(
        inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
        "wired",
        runtimeName,
      );
      fs.rmSync(runtimePath);
    }
    const indexRuntime = path.join(
      dir,
      "node_modules",
      "lefthook",
      "bin",
      "index.js",
    );
    fs.mkdirSync(path.dirname(indexRuntime), { recursive: true });
    fs.copyFileSync("/bin/sh", indexRuntime);
    fs.chmodSync(indexRuntime, 0o755);
    assert.equal(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
      "wired",
    );
    process.env.LEFTHOOK_BIN = "node_modules/lefthook/bin/index.js";
    assert.equal(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
      "wired",
    );
    delete process.env.LEFTHOOK_BIN;
    fs.rmSync(path.join(dir, "node_modules", "lefthook"), {
      recursive: true,
      force: true,
    });

    const extensionlessRuntime = path.join(runtimeBin, "lefthook.exe");
    fs.copyFileSync("/bin/sh", extensionlessRuntime);
    fs.chmodSync(extensionlessRuntime, 0o755);
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      '#!/bin/sh\nlefthook run "pre-commit"\n',
      { mode: 0o755 },
    );
    assert.equal(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
      "wired",
    );
    fs.rmSync(extensionlessRuntime);
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      lefthookRunner("pre-commit", { windows: true }).replaceAll("\n", "\r\n"),
      { mode: 0o755 },
    );

    const unsupportedCmd = path.join(runtimeBin, "lefthook.cmd");
    fs.copyFileSync("/bin/sh", unsupportedCmd);
    fs.chmodSync(unsupportedCmd, 0o755);
    assert.deepEqual(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "missing-runtime" }],
    );
    fs.rmSync(unsupportedCmd);
    const embeddedLefthook = path.join(
      dir,
      "node_modules",
      ".bin",
      "lefthook.exe",
    );
    fs.mkdirSync(path.dirname(embeddedLefthook), { recursive: true });
    fs.copyFileSync("/bin/sh", embeddedLefthook);
    fs.chmodSync(embeddedLefthook, 0o755);
    assert.equal(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
      "wired",
    );

    fs.writeFileSync(
      path.join(dir, "lefthook.yml"),
      "pre-commit:\n  commands:\n    workspace:\n      run: echo workspace\n      root: packages/app/\n",
    );
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      lefthookRunner("pre-commit", {
        roots: ["packages/app"],
        windows: true,
      }),
      { mode: 0o755 },
    );
    assert.equal(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
      "wired",
    );
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      lefthookRunner("pre-commit", { windows: true }),
      { mode: 0o755 },
    );
    assert.equal(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
      "foreign",
    );
    fs.rmSync(path.join(dir, "lefthook.yml"));

    fs.writeFileSync(path.join(dir, ".pre-commit-config.yaml"), "repos: []\n");
    fs.copyFileSync("/bin/sh", path.join(runtimeBin, "pre-commit.exe"));
    fs.chmodSync(path.join(runtimeBin, "pre-commit.exe"), 0o755);
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      preCommitRunner("pre-commit", {
        installPython: "missing/python3",
      }),
      { mode: 0o755 },
    );
    assert.equal(
      inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).status,
      "wired",
    );
  },
);

test("Lefthook canonical runners match safe workspace roots exactly", (t) => {
  const dir = createTempRepo();
  const hooksDir = path.join(dir, ".git", "hooks");
  const gitOnlyPath = path.join(dir, ".git-only-path");
  const originalPath = process.env.PATH;
  t.after(() => cleanupTempRepo(dir));
  t.after(() => {
    process.env.PATH = originalPath;
  });

  fs.rmSync(path.join(dir, "node_modules"), { recursive: true, force: true });
  fs.mkdirSync(gitOnlyPath);
  if (process.platform === "win32") {
    fs.writeFileSync(
      path.join(gitOnlyPath, "git.cmd"),
      `@"${REAL_GIT}" %*\r\n`,
    );
  } else {
    fs.symlinkSync(REAL_GIT, path.join(gitOnlyPath, "git"));
  }
  process.env.PATH = gitOnlyPath;

  const config = [
    "pre-commit:",
    "  jobs:",
    "    - run: echo library",
    "      root: packages/lib/",
    "    - run: echo duplicate",
    "      root: packages/app//",
    "  commands:",
    "    workspace:",
    "      run: echo app",
    "      root: packages/app/",
    "    commitment-issues:",
    `      run: ${hookManagerSnippets("lefthook", ["pre-commit"])[0].content.match(/^\s*run: (.+)$/mu)?.[1]}`,
    "      files: node -- node_modules/commitment-issues/scripts/lefthook-files.mjs",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "lefthook.yml"), config);

  const extension = process.platform === "win32" ? ".exe" : "";
  const runtimePlatform =
    process.platform === "win32" ? "windows" : process.platform;
  const packagedRuntime = path.join(
    dir,
    "packages",
    "app",
    "node_modules",
    `lefthook-${runtimePlatform}-${process.arch}`,
    "bin",
    `lefthook${extension}`,
  );
  fs.mkdirSync(path.dirname(packagedRuntime), { recursive: true });
  fs.writeFileSync(packagedRuntime, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const wrapperOptions = {
    embeddedExecutable: `missing/lefthook${extension}`,
    roots: ["packages/lib", "packages/app"],
  };
  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    lefthookRunner("pre-commit", wrapperOptions),
    { mode: 0o755 },
  );
  assert.equal(
    inspectHookManager("lefthook", ["pre-commit"], dir).status,
    "wired",
  );
  assert.equal(
    inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
    "wired",
  );

  fs.rmSync(packagedRuntime);
  const indexRuntime = path.join(
    dir,
    "node_modules",
    "lefthook",
    "bin",
    "index.js",
  );
  fs.mkdirSync(path.dirname(indexRuntime), { recursive: true });
  fs.writeFileSync(indexRuntime, "#!/usr/bin/env node\nprocess.exit(0);\n", {
    mode: 0o755,
  });
  assert.equal(
    inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
    "wired",
  );

  const canonicalWorkspaceWrapper = lefthookRunner(
    "pre-commit",
    wrapperOptions,
  );
  const packagedAnchor = '      "$dir/node_modules/lefthook/bin/index.js" "$@"';
  for (const malformedWrapper of [
    canonicalWorkspaceWrapper.replace(
      packagedAnchor,
      '      "$dir/node_modules/lefthook/bin/other.js" "$@"',
    ),
    canonicalWorkspaceWrapper.replace(
      "    elif go tool lefthook -h >/dev/null 2>&1",
      "    echo unexpected workspace fallback\n    elif go tool lefthook -h >/dev/null 2>&1",
    ),
  ]) {
    fs.writeFileSync(path.join(hooksDir, "pre-commit"), malformedWrapper, {
      mode: 0o755,
    });
    assert.equal(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
      "foreign",
    );
  }

  for (const roots of [
    ["packages/app"],
    ["packages/lib", "packages/app", "packages/extra"],
    ["packages/lib", "packages/app", "packages/app"],
    ["packages/lib", "packages/$HOME"],
  ]) {
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      lefthookRunner("pre-commit", { ...wrapperOptions, roots }),
      { mode: 0o755 },
    );
    assert.equal(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
      "foreign",
      roots.join(","),
    );
  }

  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    lefthookRunner("pre-commit", wrapperOptions),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(dir, "lefthook.yml"),
    config.replace("root: packages/app/", "root: ../outside/"),
  );
  assert.equal(
    inspectHookManager("lefthook", ["pre-commit"], dir).status,
    "uninspectable",
  );
  assert.equal(
    inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
    "uninspectable",
  );
});

test("commit-msg wiring is opt-in and quotes Git's message-file argument", () => {
  assert.deepEqual(hookNamesForConfig({}), ["pre-commit", "pre-push"]);
  assert.deepEqual(hookNamesForConfig({ commitMessage: { enabled: false } }), [
    "pre-commit",
    "pre-push",
  ]);
  assert.deepEqual(hookNamesForConfig({ commitMessage: { enabled: true } }), [
    "pre-commit",
    "pre-push",
    "commit-msg",
  ]);
  assert.equal(hookCommand("commit-msg"), 'commitment-issues commit-msg "$1"');
  assert.match(hookBody("commit-msg"), /commitment-issues commit-msg "\$1"/);
});

test("generated hooks never fall back to a global commitment-issues binary", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const hooksDir = path.join(tempDir, ".git", "hooks");
  writeHook(hooksDir, "pre-commit");
  fs.rmSync(path.join(tempDir, "node_modules"), {
    recursive: true,
    force: true,
  });

  const globalBin = path.join(tempDir, ".global-bin");
  fs.mkdirSync(globalBin);
  const marker = path.join(tempDir, "global-hook-ran");
  writeCrossPlatformShim(
    globalBin,
    "commitment-issues",
    'import fs from "node:fs"; fs.writeFileSync(process.env.GLOBAL_HOOK_MARKER, process.argv.slice(2).join(" "));\n',
  );

  fs.writeFileSync(path.join(tempDir, "change.txt"), "change\n");
  assert.equal(run("git", ["add", "change.txt"], tempDir).status, 0);
  const result = run(
    "git",
    ["commit", "-m", "test local hook boundary"],
    tempDir,
    {
      env: {
        ...process.env,
        PATH: `${globalBin}${path.delimiter}${process.env.PATH}`,
        GLOBAL_HOOK_MARKER: marker,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(marker), false);
  assert.match(result.stderr, /command not found; skipping pre-commit checks/);
});

test(
  "classifyHook treats symbolic-link hook paths as uninspectable",
  { skip: process.platform === "win32" },
  (t) => {
    const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-symlink-"));
    t.after(() => fs.rmSync(hooksDir, { recursive: true, force: true }));
    const target = path.join(hooksDir, "outside-target");
    fs.writeFileSync(target, hookBody("pre-commit"));
    fs.chmodSync(target, 0o755);
    fs.symlinkSync(target, path.join(hooksDir, "pre-commit"));

    assert.equal(classifyHook(hooksDir, "pre-commit"), "uninspectable");
  },
);

test(
  "writeHook refuses a symbolic-link hooks directory",
  { skip: process.platform === "win32" },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-dir-symlink-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, "target");
    const linked = path.join(root, "linked");
    fs.mkdirSync(target);
    fs.symlinkSync(target, linked);

    assert.throws(() => writeHook(linked, "pre-commit"), /hooks path/i);
    assert.equal(fs.existsSync(path.join(target, "pre-commit")), false);
  },
);

test(
  "legacy Husky cleanup never follows a symbolic-link .husky directory",
  { skip: process.platform === "win32" },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-husky-link-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, "repo");
    const outside = path.join(root, "outside");
    fs.mkdirSync(repo);
    fs.mkdirSync(path.join(outside, "_"), { recursive: true });
    fs.writeFileSync(path.join(outside, "_", "keep"), "outside\n");
    fs.writeFileSync(
      path.join(outside, "pre-commit"),
      "commitment-issues precommit\n",
    );
    fs.symlinkSync(outside, path.join(repo, ".husky"), "dir");

    assert.deepEqual(legacyHuskyWiringPaths(repo), []);
    assert.deepEqual(removeLegacyHuskyWiring(repo), []);
    assert.equal(
      fs.readFileSync(path.join(outside, "_", "keep"), "utf8"),
      "outside\n",
    );
    assert.equal(
      fs.readFileSync(path.join(outside, "pre-commit"), "utf8"),
      "commitment-issues precommit\n",
    );
  },
);

test(
  "legacy Husky cleanup rechecks the root before applying an inventory",
  { skip: process.platform === "win32" },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-husky-race-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const husky = path.join(root, ".husky");
    const parked = path.join(root, "parked-husky");
    const outside = path.join(root, "outside");
    fs.mkdirSync(husky);
    fs.mkdirSync(outside);
    fs.writeFileSync(
      path.join(husky, "pre-commit"),
      "commitment-issues precommit\n",
    );
    fs.writeFileSync(
      path.join(outside, "pre-commit"),
      "commitment-issues precommit\n",
    );

    assert.deepEqual(legacyHuskyWiringPaths(root), [".husky/pre-commit"]);
    fs.renameSync(husky, parked);
    fs.symlinkSync(outside, husky, "dir");

    assert.deepEqual(removeLegacyHuskyWiring(root), []);
    assert.equal(
      fs.readFileSync(path.join(outside, "pre-commit"), "utf8"),
      "commitment-issues precommit\n",
    );
    assert.equal(
      fs.readFileSync(path.join(parked, "pre-commit"), "utf8"),
      "commitment-issues precommit\n",
    );
  },
);

test("legacy Husky inspection rejects a non-directory root", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-husky-file-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, ".husky"), "not a directory\n");

  assert.equal(legacyHuskyDirectoryState(root).status, "uninspectable");
  assert.deepEqual(legacyHuskyWiringPaths(root), []);
  assert.deepEqual(removeLegacyHuskyWiring(root), []);
});

test("legacy Husky cleanup removes only classified in-repository artifacts", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-husky-owned-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const husky = path.join(root, ".husky");
  fs.mkdirSync(path.join(husky, "_"), { recursive: true });
  fs.writeFileSync(path.join(husky, "_", "shim"), "generated\n");
  fs.writeFileSync(path.join(husky, ".gitignore"), "_\n");
  fs.writeFileSync(
    path.join(husky, "pre-commit"),
    "commitment-issues precommit\n",
  );

  assert.deepEqual(removeLegacyHuskyWiring(root), [
    ".husky/pre-commit",
    ".husky/_",
  ]);
  assert.equal(fs.existsSync(husky), false);
});

test("legacy Husky cleanup preserves non-file hook entries", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-husky-hook-dir-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".husky", "pre-commit"), { recursive: true });
  fs.writeFileSync(path.join(root, ".husky", "_"), "not a directory\n");

  assert.deepEqual(legacyHuskyWiringPaths(root), []);
  assert.deepEqual(removeLegacyHuskyWiring(root), []);
  assert.equal(
    fs.statSync(path.join(root, ".husky", "pre-commit")).isDirectory(),
    true,
  );
  assert.equal(
    fs.readFileSync(path.join(root, ".husky", "_"), "utf8"),
    "not a directory\n",
  );
});

test("legacy Husky inspection treats a directory read failure as uninspectable", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-husky-read-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const husky = path.join(root, ".husky");
  fs.mkdirSync(husky);
  const originalReaddirSync = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (filePath, ...args) => {
    if (filePath === husky) {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    }
    return originalReaddirSync(filePath, ...args);
  });

  assert.equal(legacyHuskyDirectoryState(root).status, "uninspectable");
});

test("legacy Husky inspection rejects a root replaced during its read", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-husky-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const husky = path.join(root, ".husky");
  fs.mkdirSync(husky);
  const originalLstatSync = fs.lstatSync;
  let calls = 0;
  t.mock.method(fs, "lstatSync", (filePath, ...args) => {
    const stats = originalLstatSync(filePath, ...args);
    if (filePath === husky && (calls += 1) === 2) {
      return { ...stats, isDirectory: () => false };
    }
    return stats;
  });

  assert.equal(legacyHuskyDirectoryState(root).status, "uninspectable");
});

test("legacy Husky inventory stops when the inspected root disappears", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-husky-gone-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const husky = path.join(root, ".husky");
  fs.mkdirSync(husky);
  const originalLstatSync = fs.lstatSync;
  let calls = 0;
  t.mock.method(fs, "lstatSync", (filePath, ...args) => {
    if (filePath === husky && (calls += 1) >= 3) {
      throw Object.assign(new Error("replaced"), { code: "ENOENT" });
    }
    return originalLstatSync(filePath, ...args);
  });

  assert.deepEqual(legacyHuskyWiringPaths(root), []);
});

test("legacy Husky inventory stops when the inspected root identity changes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-husky-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const husky = path.join(root, ".husky");
  fs.mkdirSync(husky);
  fs.writeFileSync(
    path.join(husky, "pre-commit"),
    "commitment-issues precommit\n",
  );
  const originalLstatSync = fs.lstatSync;
  let rootCalls = 0;
  t.mock.method(fs, "lstatSync", (filePath, ...args) => {
    const stats = originalLstatSync(filePath, ...args);
    if (filePath === husky && (rootCalls += 1) === 3) {
      return { ...stats, ino: stats.ino + 1n };
    }
    return stats;
  });

  assert.deepEqual(legacyHuskyWiringPaths(root), []);
});

test("legacy Husky hook ownership rejects a file replaced during inspection", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "legacy-husky-hook-race-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hookPath = path.join(root, ".husky", "pre-commit");
  fs.mkdirSync(path.dirname(hookPath));
  fs.writeFileSync(hookPath, "commitment-issues precommit\n");
  const originalLstatSync = fs.lstatSync;
  let hookCalls = 0;
  t.mock.method(fs, "lstatSync", (filePath, ...args) => {
    const stats = originalLstatSync(filePath, ...args);
    if (filePath === hookPath && (hookCalls += 1) === 2) {
      return { ...stats, ino: stats.ino + 1n };
    }
    return stats;
  });

  assert.deepEqual(legacyHuskyWiringPaths(root), []);
  assert.equal(
    fs.readFileSync(hookPath, "utf8"),
    "commitment-issues precommit\n",
  );
});

test("leftover Husky inspection absorbs a post-classification read failure", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-husky-leftover-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const husky = path.join(root, ".husky");
  fs.mkdirSync(husky);
  const originalReaddirSync = fs.readdirSync;
  let reads = 0;
  t.mock.method(fs, "readdirSync", (filePath, ...args) => {
    if (filePath === husky && (reads += 1) === 2) {
      throw Object.assign(new Error("replaced"), { code: "ENOENT" });
    }
    return originalReaddirSync(filePath, ...args);
  });

  assert.deepEqual(leftoverHuskyHooks(root), []);
});

test("legacy Husky cleanup preserves artifacts when removal fails", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-husky-remove-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const husky = path.join(root, ".husky");
  const hookPath = path.join(husky, "pre-commit");
  const runtimePath = path.join(husky, "_");
  fs.mkdirSync(runtimePath, { recursive: true });
  fs.writeFileSync(hookPath, "commitment-issues precommit\n");
  const originalRmSync = fs.rmSync;
  t.mock.method(fs, "rmSync", (filePath, ...args) => {
    if (filePath === hookPath || filePath === runtimePath) {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    }
    return originalRmSync(filePath, ...args);
  });

  assert.deepEqual(removeLegacyHuskyWiring(root), []);
  assert.equal(fs.existsSync(hookPath), true);
  assert.equal(fs.existsSync(runtimePath), true);
});

test("legacy Husky cleanup stops when the final directory read fails", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-husky-final-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const husky = path.join(root, ".husky");
  fs.mkdirSync(husky);
  fs.writeFileSync(
    path.join(husky, "pre-commit"),
    "commitment-issues precommit\n",
  );
  const originalReaddirSync = fs.readdirSync;
  let reads = 0;
  t.mock.method(fs, "readdirSync", (filePath, ...args) => {
    if (filePath === husky && (reads += 1) === 2) {
      throw Object.assign(new Error("replaced"), { code: "ENOENT" });
    }
    return originalReaddirSync(filePath, ...args);
  });

  assert.deepEqual(removeLegacyHuskyWiring(root), [".husky/pre-commit"]);
  assert.equal(fs.existsSync(husky), true);
});

test("hook path probes handle unset, empty, and failed Git output", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-probes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(hooksPathConfig(dir), "");
  assert.equal(gitHooksDir(dir), null);

  const emptyConfig = fakeGitEnv(dir, "--get core.hooksPath", 0, "\0");
  assert.equal(hooksPathConfig(dir, emptyConfig), "");

  const emptyCommonDir = fakeGitEnv(dir, "rev-parse --git-common-dir", 0, "");
  assert.equal(gitHooksDir(dir, emptyCommonDir), null);

  const missingGit = { ...process.env, PATH: path.join(dir, "missing-bin") };
  assert.match(
    hooksPathConfigState(dir, missingGit).error,
    /(?:spawn.*git.*ENOENT|'git' is not recognized)/iu,
  );
});

test("hook path state distinguishes an unset value from a failed Git probe", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-path-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const unset = fakeGitEnv(dir, "--get core.hooksPath", 1);
  assert.deepEqual(hooksPathConfigState(dir, unset), {
    value: "",
    present: false,
    error: null,
  });

  const configured = fakeGitEnv(
    dir,
    "--get core.hooksPath",
    0,
    "custom hooks\0",
  );
  assert.deepEqual(hooksPathConfigState(dir, configured), {
    value: "custom hooks",
    present: true,
    error: null,
  });

  const failed = fakeGitEnv(dir, "--get core.hooksPath", 128);
  assert.equal(hooksPathConfigState(dir, failed).value, "");
  assert.match(hooksPathConfigState(dir, failed).error, /core\.hooksPath/);
});

test("hook path state rejects malformed status-zero NUL output", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-path-malformed-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  for (const stdout of ["", "unterminated", "first\0second\0", "\0\0"]) {
    const env = fakeGitEnv(dir, "--get core.hooksPath", 0, stdout);
    const state = hooksPathConfigState(dir, env);
    assert.deepEqual(
      { value: state.value, present: state.present },
      { value: "", present: false },
    );
    assert.match(state.error, /malformed NUL-delimited output/);
  }
});

test("hook path state preserves configured whitespace and empty values exactly", (t) => {
  const dir = createTempRepo();
  t.after(() => cleanupTempRepo(dir));

  for (const configured of [" .husky", ".husky ", ".husky\n", ""]) {
    const set = run("git", ["config", "core.hooksPath", configured], dir);
    assert.equal(set.status, 0, `${set.stdout}${set.stderr}`);
    assert.deepEqual(hooksPathConfigState(dir), {
      value: configured,
      present: true,
      error: null,
    });
    assert.equal(hooksPathConfig(dir), configured);
    assert.equal(isHuskyHooksPath(configured), false);
    assert.equal(effectiveHooksDir(dir), path.resolve(dir, configured || "./"));
  }

  const unset = run("git", ["config", "--unset", "core.hooksPath"], dir);
  assert.equal(unset.status, 0, `${unset.stdout}${unset.stderr}`);
  assert.deepEqual(hooksPathConfigState(dir), {
    value: "",
    present: false,
    error: null,
  });
});

test("gitHooksDir resolves relative common directories against the requested cwd", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-common-dir-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const env = fakeGitEnv(dir, "rev-parse --git-common-dir", 0, ".git\n");
  assert.equal(gitHooksDir(dir, env), path.join(dir, ".git", "hooks"));
});

test("effectiveHooksDir resolves Git's configured hook path output", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-effective-dir-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const resolved = fakeGitEnv(
    dir,
    "rev-parse --git-path hooks",
    0,
    "../shared hooks\n",
  );
  assert.equal(
    effectiveHooksDir(dir, resolved),
    path.resolve(dir, "../shared hooks"),
  );

  const crlf = fakeGitEnv(
    dir,
    "rev-parse --git-path hooks",
    0,
    "../CRLF hooks\r\n",
  );
  assert.equal(
    effectiveHooksDir(dir, crlf),
    path.resolve(dir, "../CRLF hooks"),
  );

  const unterminated = fakeGitEnv(
    dir,
    "rev-parse --git-path hooks",
    0,
    "../unterminated hooks",
  );
  assert.equal(
    effectiveHooksDir(dir, unterminated),
    path.resolve(dir, "../unterminated hooks"),
  );

  const failed = fakeGitEnv(dir, "rev-parse --git-path hooks", 128);
  assert.equal(effectiveHooksDir(dir, failed), null);

  const empty = fakeGitEnv(dir, "rev-parse --git-path hooks", 0, "");
  assert.equal(effectiveHooksDir(dir, empty), null);
});

test("git work-tree state distinguishes normal, bare, and missing repositories", (t) => {
  const worktree = createTempRepo();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "hook-bare-repo-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "hook-no-repo-"));
  t.after(() => cleanupTempRepo(worktree));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  assert.equal(run("git", ["init", "--bare"], bare).status, 0);
  assert.deepEqual(gitWorkTreeState(worktree), {
    inside: true,
    bare: false,
  });
  assert.deepEqual(gitWorkTreeState(bare), { inside: false, bare: true });
  assert.deepEqual(gitWorkTreeState(outside), {
    inside: false,
    bare: false,
  });
});

test("classifyHook reports an uninspectable hook path without throwing", (t) => {
  const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-unreadable-"));
  t.after(() => fs.rmSync(hooksDir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(hooksDir, "pre-commit"));
  assert.equal(classifyHook(hooksDir, "pre-commit"), "uninspectable");
});

test("classifyHook absorbs a hook read failure", (t) => {
  const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-read-failure-"));
  t.after(() => fs.rmSync(hooksDir, { recursive: true, force: true }));

  const hookPath = path.join(hooksDir, "pre-commit");
  fs.writeFileSync(hookPath, "#!/bin/sh\n");
  const originalReadFileSync = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (filePath, ...args) => {
    if (filePath === hookPath) {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    }
    return originalReadFileSync(filePath, ...args);
  });

  assert.equal(classifyHook(hooksDir, "pre-commit"), "uninspectable");
});

test("classifyHook fails closed when its hooks directory disappears after reading", (t) => {
  const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-dir-race-"));
  t.after(() => fs.rmSync(hooksDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(hooksDir, "pre-commit"), hookBody("pre-commit"), {
    mode: 0o755,
  });

  const originalLstatSync = fs.lstatSync;
  let directoryReads = 0;
  t.mock.method(fs, "lstatSync", (filePath, ...args) => {
    if (path.resolve(String(filePath)) === path.resolve(hooksDir)) {
      directoryReads += 1;
      if (directoryReads === 2) {
        throw Object.assign(new Error("injected post-read failure"), {
          code: "EIO",
        });
      }
    }
    return originalLstatSync(filePath, ...args);
  });

  assert.equal(classifyHook(hooksDir, "pre-commit"), "uninspectable");
  assert.equal(directoryReads, 2);
});

test("classifyHook handles hook names without a generated-body history", (t) => {
  const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-unknown-name-"));
  t.after(() => fs.rmSync(hooksDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(hooksDir, "post-commit"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });

  assert.equal(classifyHook(hooksDir, "post-commit"), "custom-without-command");
});

test("Husky hooksPath recognition follows platform separator semantics", () => {
  assert.equal(isHuskyHooksPath(undefined, "linux"), false);
  assert.equal(isHuskyHooksPath(null, "linux"), false);
  assert.equal(isHuskyHooksPath(" .husky/_/ ", "linux"), false);
  assert.equal(isHuskyHooksPath(".husky\\_\\\\", "linux"), false);
  assert.equal(isHuskyHooksPath(".husky\\_\\\\", "win32"), true);
  assert.equal(isHuskyHooksPath(".husky\\", "win32"), true);
  assert.equal(isHuskyHooksPath(" .husky\\_", "win32"), false);
  assert.equal(isHuskyHooksPath(".husky////", "linux"), true);
  assert.equal(isHuskyHooksPath("custom/hooks", "linux"), false);
  assert.equal(isHuskyDirectHooksPath(".husky\\", "win32"), true);
  assert.equal(isHuskyDirectHooksPath(".husky\\_", "win32"), false);
  assert.equal(isHuskyDirectHooksPath(".husky\\", "linux"), false);
});

test("Husky hooksPath recognition rejects long separator runs promptly", () => {
  const adversarialValue = `.husky/${"/".repeat(40_000)}x`;
  const startedAt = performance.now();

  assert.equal(isHuskyHooksPath(adversarialValue), false);

  const elapsedMs = performance.now() - startedAt;
  assert.ok(
    elapsedMs < 500,
    `hooksPath normalization took ${elapsedMs.toFixed(1)} ms`,
  );
});

test("generated commit-msg hooks are executable and exact-match owned", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "commit-msg-hook-"));
  try {
    writeHook(dir, "commit-msg");
    const hookPath = path.join(dir, "commit-msg");
    assert.equal(fs.readFileSync(hookPath, "utf8"), hookBody("commit-msg"));
    assert.equal(classifyHook(dir, "commit-msg"), "wired");
    if (process.platform !== "win32") {
      assert.ok(fs.statSync(hookPath).mode & 0o111);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("custom commit-msg hooks require the safely quoted invocation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "custom-commit-msg-"));
  try {
    const hookPath = path.join(dir, "commit-msg");
    fs.writeFileSync(hookPath, "commitment-issues commit-msg $1\n");
    fs.chmodSync(hookPath, 0o755);
    assert.equal(classifyHook(dir, "commit-msg"), "custom-without-command");

    fs.writeFileSync(
      hookPath,
      '# commitment-issues commit-msg "$1"\necho custom\n',
    );
    fs.chmodSync(hookPath, 0o755);
    assert.equal(classifyHook(dir, "commit-msg"), "custom-without-command");

    fs.writeFileSync(
      hookPath,
      '#!/bin/sh\nnode_modules/.bin/commitment-issues commit-msg "$1" || exit $?\necho custom\n',
    );
    fs.chmodSync(hookPath, 0o755);
    assert.equal(classifyHook(dir, "commit-msg"), "custom-with-legacy-command");

    fs.writeFileSync(
      hookPath,
      `#!/bin/sh\n${hookInvocation("commit-msg")}\necho custom\n`,
    );
    fs.chmodSync(hookPath, 0o755);
    assert.equal(classifyHook(dir, "commit-msg"), "custom-with-command");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hook-manager detection reports evidence without guessing an owner", (t) => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "hook-manager detection [] ; '-"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.deepEqual(detectHookManagers(dir, {}), {
    managers: [],
    evidence: { husky: [], lefthook: [], "pre-commit": [] },
    configFiles: {
      husky: {
        status: "missing",
        destination: null,
        present: [],
        unsafe: [],
      },
      lefthook: {
        status: "missing",
        destination: null,
        present: [],
        unsafe: [],
      },
      "pre-commit": {
        status: "missing",
        destination: null,
        present: [],
        unsafe: [],
      },
    },
    lintStaged: false,
    unsafePaths: [],
  });

  fs.mkdirSync(path.join(dir, ".husky"));
  fs.writeFileSync(path.join(dir, "lefthook.yaml"), "pre-commit: {}\n");
  fs.writeFileSync(path.join(dir, ".pre-commit-config.yaml"), "repos: []\n");
  fs.writeFileSync(path.join(dir, ".lintstagedrc.json"), "{}\n");
  const detected = detectHookManagers(dir, {
    devDependencies: { husky: "9", lefthook: "2", "lint-staged": "16" },
  });
  assert.deepEqual(detected.managers, ["husky", "lefthook", "pre-commit"]);
  assert.deepEqual(detected.evidence.husky, [
    "package dependency husky",
    ".husky/",
  ]);
  assert.deepEqual(detected.evidence.lefthook, [
    "package dependency lefthook",
    "lefthook.yaml",
  ]);
  assert.deepEqual(detected.evidence["pre-commit"], [
    ".pre-commit-config.yaml",
  ]);
  assert.deepEqual(detected.configFiles.lefthook, {
    status: "selected",
    destination: "lefthook.yaml",
    present: ["lefthook.yaml"],
    unsafe: [],
  });
  assert.deepEqual(detected.configFiles["pre-commit"], {
    status: "selected",
    destination: ".pre-commit-config.yaml",
    present: [".pre-commit-config.yaml"],
    unsafe: [],
  });
  assert.equal(detected.lintStaged, true);
  assert.deepEqual(detected.unsafePaths, []);
});

test("hook-manager configuration selection rejects duplicate candidates", (t) => {
  for (const [manager, candidates] of [
    ["lefthook", ["lefthook.yml", ".lefthook.yml"]],
    ["pre-commit", [".pre-commit-config.yaml", ".pre-commit-config.yml"]],
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${manager}-duplicate-`));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const candidate of candidates) {
      fs.writeFileSync(path.join(dir, candidate), "pre-commit: {}\n");
    }

    const detected = detectHookManagers(dir, {});
    assert.deepEqual(detected.managers, [manager]);
    assert.deepEqual(detected.configFiles[manager], {
      status: "uninspectable",
      destination: null,
      present: candidates,
      unsafe: [],
    });
    const report = inspectHookManager(manager, ["pre-commit"], dir);
    assert.equal(report.status, "uninspectable");
    assert.equal(report.destination, null);
  }
});

test("hook-manager config inspection fails closed on opaque parent errors", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manager-parent-error-"));
  const configDir = path.join(dir, ".config");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, "lefthook.yml"), "pre-commit: {}\n");

  const originalLstatSync = fs.lstatSync;
  let injected = false;
  t.mock.method(fs, "lstatSync", (filePath, ...args) => {
    if (
      !injected &&
      path.resolve(String(filePath)) === path.resolve(configDir)
    ) {
      injected = true;
      throw undefined;
    }
    return originalLstatSync(filePath, ...args);
  });

  assert.equal(
    inspectHookManager("lefthook", ["pre-commit"], dir).status,
    "uninspectable",
  );
  assert.equal(injected, true);
});

test("hook-manager config inspection rechecks parent identity", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manager-parent-race-"));
  const configDir = path.join(dir, ".config");
  const decoyDir = path.join(dir, "decoy");
  const configPath = path.join(configDir, "lefthook.yml");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(configDir);
  fs.mkdirSync(decoyDir);
  fs.writeFileSync(configPath, "pre-commit: {}\n");

  const originalReadFileSync = fs.readFileSync;
  const originalLstatSync = fs.lstatSync;
  let configRead = false;
  let injected = false;
  t.mock.method(fs, "readFileSync", (filePath, ...args) => {
    const content = originalReadFileSync(filePath, ...args);
    if (path.resolve(String(filePath)) === path.resolve(configPath)) {
      configRead = true;
    }
    return content;
  });
  t.mock.method(fs, "lstatSync", (filePath, ...args) => {
    if (
      !injected &&
      configRead &&
      path.resolve(String(filePath)) === path.resolve(configDir)
    ) {
      injected = true;
      return originalLstatSync(decoyDir, ...args);
    }
    return originalLstatSync(filePath, ...args);
  });

  assert.equal(
    inspectHookManager("lefthook", ["pre-commit"], dir).status,
    "uninspectable",
  );
  assert.equal(injected, true);
});

test("hook-manager runner inspection rechecks its directory identity", (t) => {
  const dir = createTempRepo();
  const hooksDir = path.join(dir, ".husky", "_");
  const decoyDir = path.join(dir, "decoy");
  const runtimePath = path.join(hooksDir, "h");
  t.after(() => cleanupTempRepo(dir));
  assert.equal(
    run("git", ["config", "core.hooksPath", ".husky/_"], dir).status,
    0,
  );
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(decoyDir);
  fs.writeFileSync(runtimePath, HUSKY_V9_RUNTIME);
  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n',
    { mode: 0o755 },
  );

  const originalReadFileSync = fs.readFileSync;
  const originalLstatSync = fs.lstatSync;
  let runtimeRead = false;
  let injected = false;
  t.mock.method(fs, "readFileSync", (filePath, ...args) => {
    const content = originalReadFileSync(filePath, ...args);
    if (path.resolve(String(filePath)) === path.resolve(runtimePath)) {
      runtimeRead = true;
    }
    return content;
  });
  t.mock.method(fs, "lstatSync", (filePath, ...args) => {
    if (
      !injected &&
      runtimeRead &&
      path.resolve(String(filePath)) === path.resolve(hooksDir)
    ) {
      injected = true;
      return originalLstatSync(decoyDir, ...args);
    }
    return originalLstatSync(filePath, ...args);
  });

  assert.equal(
    inspectHookManagerRunner("husky", ["pre-commit"], dir).status,
    "uninspectable",
  );
  assert.equal(injected, true);
});

test("Lefthook discovery covers every official main and local config", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lefthook-configs-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inspectable = new Set([
    "lefthook.yml",
    "lefthook.yaml",
    ".lefthook.yml",
    ".lefthook.yaml",
    ".config/lefthook.yml",
    ".config/lefthook.yaml",
  ]);
  const candidates = [".yml", ".yaml", ".json", ".jsonc", ".toml"].flatMap(
    (extension) =>
      [
        "lefthook",
        ".lefthook",
        ".config/lefthook",
        "lefthook-local",
        ".lefthook-local",
        ".config/lefthook-local",
      ].map((stem) => `${stem}${extension}`),
  );

  for (const filename of candidates) {
    fs.mkdirSync(path.dirname(path.join(dir, filename)), { recursive: true });
    fs.writeFileSync(path.join(dir, filename), "pre-commit: {}\n");
    const detected = detectHookManagers(dir, {}, {});
    assert.deepEqual(detected.managers, ["lefthook"], filename);
    assert.equal(
      detected.configFiles.lefthook.status,
      inspectable.has(filename) ? "selected" : "uninspectable",
      filename,
    );
    assert.deepEqual(detected.configFiles.lefthook.present, [filename]);
    const report = inspectHookManager("lefthook", ["pre-commit"], dir);
    assert.equal(
      report.status,
      inspectable.has(filename) ? "missing" : "uninspectable",
      filename,
    );
    fs.rmSync(path.join(dir, filename));
  }
});

test("Lefthook overrides and linked config parents fail closed", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lefthook-override-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lefthook-parent-"));
  const hadLefthookConfig = Object.hasOwn(process.env, "LEFTHOOK_CONFIG");
  const originalLefthookConfig = process.env.LEFTHOOK_CONFIG;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  t.after(() => {
    if (hadLefthookConfig) {
      process.env.LEFTHOOK_CONFIG = originalLefthookConfig;
    } else {
      delete process.env.LEFTHOOK_CONFIG;
    }
  });

  const overridden = detectHookManagers(
    dir,
    {},
    { LEFTHOOK_CONFIG: "custom.toml" },
  );
  assert.deepEqual(overridden.managers, ["lefthook"]);
  assert.equal(overridden.configFiles.lefthook.status, "uninspectable");
  assert.ok(overridden.evidence.lefthook.includes("LEFTHOOK_CONFIG override"));

  process.env.LEFTHOOK_CONFIG = "custom.toml";
  const inspectedOverride = inspectHookManager("lefthook", ["pre-commit"], dir);
  assert.deepEqual(inspectedOverride, {
    manager: "lefthook",
    destination: null,
    status: "uninspectable",
    hooks: [{ name: "pre-commit", status: "uninspectable" }],
  });
  if (hadLefthookConfig) {
    process.env.LEFTHOOK_CONFIG = originalLefthookConfig;
  } else {
    delete process.env.LEFTHOOK_CONFIG;
  }

  if (process.platform !== "win32") {
    fs.writeFileSync(path.join(outside, "lefthook.yml"), "pre-commit: {}\n");
    fs.symlinkSync(outside, path.join(dir, ".config"));
    const linked = detectHookManagers(dir, {}, {});
    assert.deepEqual(linked.managers, ["lefthook"]);
    assert.ok(
      linked.configFiles.lefthook.unsafe.includes(".config/lefthook.yml"),
    );
    assert.equal(
      inspectHookManager("lefthook", ["pre-commit"], dir).status,
      "uninspectable",
    );
  }
});

test("lint-staged detection covers every standalone config filename", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-staged-rc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  for (const filename of [
    ".lintstagedrc",
    ".lintstagedrc.json",
    ".lintstagedrc.yaml",
    ".lintstagedrc.yml",
    ".lintstagedrc.js",
    ".lintstagedrc.mjs",
    ".lintstagedrc.cjs",
    ".lintstagedrc.ts",
    ".lintstagedrc.mts",
    ".lintstagedrc.cts",
    "lint-staged.config.js",
    "lint-staged.config.mjs",
    "lint-staged.config.cjs",
    "lint-staged.config.ts",
    "lint-staged.config.mts",
    "lint-staged.config.cts",
  ]) {
    fs.writeFileSync(path.join(dir, filename), "export default {};\n");
    assert.equal(detectHookManagers(dir, {}, {}).lintStaged, true, filename);
    fs.rmSync(path.join(dir, filename));
  }
});

test("lint-staged package YAML requires a real top-level key", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-staged-package-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  for (const filename of ["package.yaml", "package.yml"]) {
    fs.writeFileSync(path.join(dir, filename), "name: fixture\n");
    assert.equal(detectHookManagers(dir, {}, {}).lintStaged, false);
    fs.writeFileSync(
      path.join(dir, filename),
      'metadata:\n  nested: true\n"lint-staged" :\n  "*.js": eslint\n',
    );
    assert.equal(detectHookManagers(dir, {}, {}).lintStaged, true);
    fs.writeFileSync(
      path.join(dir, filename),
      "example: |2-\n    lint-staged:\n      '*.js': eslint\n",
    );
    assert.equal(detectHookManagers(dir, {}, {}).lintStaged, false);
    fs.rmSync(path.join(dir, filename));
  }

  fs.mkdirSync(path.join(dir, "package.yaml"));
  const unsafePackageYaml = detectHookManagers(dir, {}, {});
  assert.equal(unsafePackageYaml.lintStaged, false);
  assert.ok(unsafePackageYaml.unsafePaths.includes("package.yaml"));
});

test("hook-manager detection rejects linked and wrong-kind evidence", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-manager-unsafe-"));
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), "hook-manager-outside-"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  fs.writeFileSync(path.join(outside, "config"), "pre-commit: {}\n");
  fs.symlinkSync(path.join(outside, "config"), path.join(dir, "lefthook.yml"));
  fs.writeFileSync(path.join(dir, ".husky"), "not a directory\n");
  fs.mkdirSync(path.join(dir, ".pre-commit-config.yml"));
  fs.mkdirSync(path.join(dir, "lint-staged.config.js"));

  const detected = detectHookManagers(dir, { "lint-staged": {} });
  assert.deepEqual(detected.managers, ["husky", "lefthook", "pre-commit"]);
  assert.deepEqual(detected.configFiles.husky, {
    status: "uninspectable",
    destination: null,
    present: [],
    unsafe: [".husky"],
  });
  assert.equal(detected.lintStaged, true);
  assert.deepEqual(detected.unsafePaths.sort(), [
    ".husky",
    ".pre-commit-config.yml",
    "lefthook.yml",
    "lint-staged.config.js",
  ]);
});

test("Husky inspection rejects a linked manager root before reading it", (t) => {
  const dir = createTempRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "husky-root-target-"));
  t.after(() => cleanupTempRepo(dir));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  fs.mkdirSync(path.join(outside, "_"), { recursive: true });
  fs.writeFileSync(
    path.join(outside, "pre-commit"),
    "node_modules/.bin/commitment-issues hook precommit || exit $?\n",
  );
  fs.symlinkSync(outside, path.join(dir, ".husky"), "dir");
  run("git", ["config", "core.hooksPath", ".husky/_"], dir);

  let outsideReads = 0;
  const originalRead = fs.readFileSync;
  fs.readFileSync = (...args) => {
    if (path.resolve(String(args[0])).startsWith(path.resolve(outside))) {
      outsideReads += 1;
    }
    return originalRead(...args);
  };
  try {
    assert.equal(
      inspectHookManager("husky", ["pre-commit"], dir).status,
      "uninspectable",
    );
    assert.equal(
      inspectHookManagerRunner("husky", ["pre-commit"], dir).status,
      "uninspectable",
    );
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(outsideReads, 0);
});

test("Husky runner inspection rejects a linked runtime directory before reading it", (t) => {
  const dir = createTempRepo();
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), "husky-runtime-target-"),
  );
  t.after(() => cleanupTempRepo(dir));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  fs.mkdirSync(path.join(dir, ".husky"));
  fs.writeFileSync(path.join(outside, "h"), "outside runtime\n");
  fs.writeFileSync(path.join(outside, "pre-commit"), "outside wrapper\n");
  fs.symlinkSync(outside, path.join(dir, ".husky", "_"), "dir");
  run("git", ["config", "core.hooksPath", ".husky/_"], dir);

  let outsideReads = 0;
  const originalRead = fs.readFileSync;
  fs.readFileSync = (...args) => {
    if (path.resolve(String(args[0])).startsWith(path.resolve(outside))) {
      outsideReads += 1;
    }
    return originalRead(...args);
  };
  try {
    assert.equal(
      inspectHookManagerRunner("husky", ["pre-commit"], dir).status,
      "uninspectable",
    );
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(outsideReads, 0);
});

test("Husky runner inspection rechecks runtime and wrapper parent directories", (t) => {
  const dir = createTempRepo();
  t.after(() => cleanupTempRepo(dir));
  assert.equal(
    run("git", ["config", "core.hooksPath", ".husky/_"], dir).status,
    0,
  );
  const hooksDir = path.join(dir, ".husky", "_");
  const runtimePath = path.join(hooksDir, "h");
  const wrapperPath = path.join(hooksDir, "pre-commit");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(runtimePath, HUSKY_V9_RUNTIME);
  fs.writeFileSync(wrapperPath, '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n', {
    mode: 0o755,
  });

  let targetRead = runtimePath;
  let readObserved = false;
  let injected = false;
  const originalReadFileSync = fs.readFileSync;
  const originalLstatSync = fs.lstatSync;
  t.mock.method(fs, "readFileSync", (filePath, ...args) => {
    const content = originalReadFileSync(filePath, ...args);
    if (path.resolve(String(filePath)) === path.resolve(targetRead)) {
      readObserved = true;
    }
    return content;
  });
  t.mock.method(fs, "lstatSync", (filePath, ...args) => {
    if (
      path.resolve(String(filePath)) === path.resolve(hooksDir) &&
      readObserved &&
      !injected
    ) {
      injected = true;
      throw Object.assign(new Error("injected parent recheck failure"), {
        code: "EIO",
      });
    }
    return originalLstatSync(filePath, ...args);
  });

  assert.deepEqual(
    inspectHookManagerRunner("husky", ["pre-commit"], dir).hooks,
    [{ name: "pre-commit", status: "uninspectable" }],
  );
  assert.equal(injected, true);

  targetRead = wrapperPath;
  readObserved = false;
  injected = false;
  assert.deepEqual(
    inspectHookManagerRunner("husky", ["pre-commit"], dir).hooks,
    [{ name: "pre-commit", status: "uninspectable" }],
  );
  assert.equal(injected, true);
});

test("hook-manager detection reads package metadata fail-soft", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-manager-package-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, "package.json"), "not json\n");
  assert.deepEqual(detectHookManagers(dir).managers, []);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    '{"optionalDependencies":{"husky":"9"},"dependencies":{"lint-staged":"16"}}\n',
  );
  const detected = detectHookManagers(dir);
  assert.deepEqual(detected.managers, ["husky"]);
  assert.equal(detected.lintStaged, true);
});

test("hook-manager inspection fails closed on exceptional and incomplete paths", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-manager-edges-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const huskyPath = path.join(dir, ".husky");
  const originalLstat = fs.lstatSync;
  fs.lstatSync = (...args) => {
    if (path.resolve(String(args[0])) === huskyPath) {
      throw Object.assign(new Error("injected filesystem failure"), {
        code: "EACCES",
      });
    }
    return originalLstat(...args);
  };
  try {
    assert.ok(detectHookManagers(dir, {}).unsafePaths.includes(".husky"));
  } finally {
    fs.lstatSync = originalLstat;
  }
  assert.equal(detectHookManagers(dir, null).lintStaged, false);

  fs.mkdirSync(path.join(dir, ".husky"));
  const hookPath = path.join(dir, ".husky", "pre-commit");
  fs.writeFileSync(
    hookPath,
    "node_modules/.bin/commitment-issues hook precommit || exit $?\n",
  );
  const originalRead = fs.readFileSync;
  fs.readFileSync = (...args) => {
    const content = originalRead(...args);
    if (path.resolve(String(args[0])) === hookPath) {
      fs.renameSync(hookPath, `${hookPath}.old`);
      fs.writeFileSync(hookPath, "replacement\n");
    }
    return content;
  };
  try {
    assert.equal(
      inspectHookManager("husky", ["pre-commit"], dir).status,
      "uninspectable",
    );
  } finally {
    fs.readFileSync = originalRead;
  }

  const lefthookPath = path.join(dir, "lefthook.yml");
  fs.writeFileSync(lefthookPath, "pre-commit:\n");
  assert.equal(
    inspectHookManager("lefthook", ["pre-commit"], dir).status,
    "uninspectable",
  );

  fs.readFileSync = (...args) => {
    if (path.resolve(String(args[0])) === lefthookPath) {
      throw Object.assign(new Error("injected filesystem failure"), {
        code: "EACCES",
      });
    }
    return originalRead(...args);
  };
  try {
    assert.equal(
      inspectHookManager("lefthook", ["pre-commit"], dir).status,
      "uninspectable",
    );
  } finally {
    fs.readFileSync = originalRead;
  }

  fs.writeFileSync(
    lefthookPath,
    "pre-commit:\n  commands:\n    commitment-issues:\n",
  );
  assert.equal(
    inspectHookManager("lefthook", ["pre-commit"], dir).status,
    "uninspectable",
  );
});

test("manager snippets are static, local-only, and preserve hook inputs", () => {
  const names = ["pre-commit", "pre-push", "commit-msg"];
  const husky = hookManagerSnippets("husky", names);
  assert.deepEqual(
    husky.map(({ destination }) => destination),
    [".husky/pre-commit", ".husky/pre-push", ".husky/commit-msg"],
  );
  assert.equal(husky[0].content, `${hookInvocation("pre-commit")}\n`);
  assert.match(husky[1].content, /hook prepush "\$@"/u);
  assert.match(husky[2].content, /hook commit-msg "\$1"/u);

  const lefthook = hookManagerSnippets("lefthook", names, "custom.yaml");
  assert.ok(lefthook.every(({ destination }) => destination === "custom.yaml"));
  assert.match(lefthook[1].content, /run: .* hook prepush; fi; fi; done$/mu);
  assert.match(lefthook[2].content, /hook commit-msg --git-path/u);
  assert.ok(
    lefthook.every(({ content }) =>
      content.includes(
        "for commitment_issues_bin in node_modules/.bin/commitment-issues node_modules/.bin/commitment-issues.exe node_modules/.bin/commitment-issues.cmd node_modules/.bin/commitment-issues.bat",
      ),
    ),
  );
  assert.ok(
    lefthook
      .slice(0, 2)
      .every(({ content }) =>
        content.includes(
          'COMMITMENT_ISSUES_LEFTHOOK_FILE={files} exec "$commitment_issues_bin"',
        ),
      ),
  );
  assert.ok(
    lefthook
      .slice(0, 2)
      .every(
        ({ content }) =>
          content.match(/\{files\}/gu)?.length === 1 &&
          content.includes(
            "files: node -- node_modules/commitment-issues/scripts/lefthook-files.mjs",
          ) &&
          !/\{(?:staged_files|push_files|all_files)\}/u.test(content),
      ),
  );
  assert.ok(!/[{}]/u.test(lefthook[2].content));
  assert.match(lefthook[1].content, /use_stdin: true/u);
  assert.doesNotMatch(lefthook[0].content, /use_stdin/u);

  const preCommit = hookManagerSnippets("pre-commit", names, "hooks.yaml");
  assert.match(preCommit[0].content, /pass_filenames: false/u);
  assert.match(preCommit[2].content, /pass_filenames: true/u);
  assert.ok(
    preCommit.every(
      ({ content }) =>
        content.includes("entry: sh -c 'for commitment_issues_bin in") &&
        content.includes('exec "$commitment_issues_bin" hook'),
    ),
  );
  assert.ok(
    [...husky, ...lefthook, ...preCommit].every(
      ({ content }) => !content.includes(process.cwd()),
    ),
  );
  assert.equal(
    hookManagerInstallCommand("pre-commit", names, ".pre-commit-config.yaml"),
    "pre-commit install --hook-type pre-commit --hook-type pre-push --hook-type commit-msg",
  );
  assert.equal(
    hookManagerInstallCommand("pre-commit", names, ".pre-commit-config.yml"),
    "pre-commit install --config .pre-commit-config.yml --hook-type pre-commit --hook-type pre-push --hook-type commit-msg",
  );
  assert.equal(
    hookManagerInstallCommand("lefthook", names),
    "lefthook install",
  );
  assert.match(hookManagerInstallCommand("husky", names), /Husky install/u);
  assert.throws(
    () => hookManagerSnippets("unknown", names),
    /Unsupported hook manager/u,
  );
  assert.throws(
    () => hookManagerInstallCommand("unknown", names),
    /Unsupported hook manager/u,
  );
  assert.throws(
    () => inspectHookManager("unknown", names),
    /Unsupported hook manager/u,
  );
});

test("manager snippets fail open only while the exact project-local bin is unusable", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manager-bin-guard-"));
  const bin = path.join(dir, "node_modules", ".bin", "commitment-issues");
  const globalBin = path.join(dir, "global-bin");
  const globalMarker = path.join(dir, "global-fallback");
  const continued = path.join(dir, "continued");
  const argvCapture = path.join(dir, "argv");
  const sentinelCapture = path.join(dir, "sentinel");
  const injected = path.join(dir, "injected");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.mkdirSync(globalBin);
  fs.writeFileSync(
    path.join(globalBin, "commitment-issues"),
    `#!/bin/sh\nprintf global > ${quoteShellWord(globalMarker)}\n`,
    { mode: 0o755 },
  );

  const hostileRemote = "origin ; touch injected";
  const remoteUrl = "ssh://example.invalid/repo";
  const messagePath = "message ; $(touch injected) [unicode 雪]";
  const huskyPath = path.join(dir, "husky-hook");
  fs.writeFileSync(
    huskyPath,
    `#!/bin/sh\n${hookManagerSnippets("husky", ["pre-push"])[0].content}printf continued > continued\n`,
    { mode: 0o755 },
  );
  const lefthookCommand = hookManagerSnippets("lefthook", [
    "pre-commit",
  ])[0].content.match(/^\s*run: (.+)$/mu)?.[1];
  const preCommitCommand = hookManagerSnippets("pre-commit", [
    "commit-msg",
  ])[0].content.match(/entry: sh -c '([^']+)' --$/mu)?.[1];
  assert.ok(lefthookCommand);
  assert.ok(preCommitCommand);

  const baseEnv = {
    ...process.env,
    PATH: `${globalBin}${path.delimiter}${process.env.PATH ?? ""}`,
    MANAGER_ARGV_CAPTURE: argvCapture,
    MANAGER_SENTINEL_CAPTURE: sentinelCapture,
  };
  const entries = [
    {
      manager: "husky",
      expectedArgs: ["hook", "prepush", hostileRemote, remoteUrl],
      run: (env) =>
        run("sh", [huskyPath, hostileRemote, remoteUrl], dir, { env }),
    },
    {
      manager: "lefthook",
      expectedArgs: ["hook", "precommit"],
      run: (env) => run("sh", ["-c", lefthookCommand], dir, { env }),
    },
    {
      manager: "pre-commit",
      expectedArgs: ["hook", "commit-msg", messagePath],
      run: (env) =>
        run("sh", ["-c", preCommitCommand, "--", messagePath], dir, {
          env,
        }),
    },
  ];
  const assertFailOpen = (state) => {
    for (const entry of entries) {
      fs.rmSync(globalMarker, { force: true });
      fs.rmSync(continued, { force: true });
      const result = entry.run(baseEnv);
      assert.equal(
        result.status,
        0,
        `${entry.manager} ${state}: ${result.stdout}${result.stderr}`,
      );
      assert.equal(fs.existsSync(globalMarker), false, entry.manager);
      if (entry.manager === "husky") {
        assert.equal(fs.readFileSync(continued, "utf8"), "continued");
      }
    }
  };

  assertFailOpen("missing");
  fs.mkdirSync(bin);
  assertFailOpen("wrong-kind");
  fs.rmSync(bin, { recursive: true });
  if (process.platform !== "win32") {
    fs.writeFileSync(bin, "#!/bin/sh\nexit 99\n", { mode: 0o644 });
    assertFailOpen("non-executable");
    fs.rmSync(bin);
  }

  const executableBin = process.platform === "win32" ? bin : `${bin}.exe`;
  fs.writeFileSync(
    executableBin,
    [
      "#!/bin/sh",
      'printf \'%s\\0\' "$@" > "$MANAGER_ARGV_CAPTURE"',
      'printf \'%s\' "${COMMITMENT_ISSUES_LEFTHOOK_FILE-}" > "$MANAGER_SENTINEL_CAPTURE"',
      'exit "$MANAGER_TEST_EXIT"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.chmodSync(executableBin, 0o755);

  for (const [index, entry] of entries.entries()) {
    fs.rmSync(continued, { force: true });
    fs.rmSync(argvCapture, { force: true });
    fs.rmSync(sentinelCapture, { force: true });
    const expectedStatus = 23 + index;
    const result = entry.run({
      ...baseEnv,
      MANAGER_TEST_EXIT: String(expectedStatus),
    });
    assert.equal(
      result.status,
      expectedStatus,
      `${entry.manager}: ${result.stdout}${result.stderr}`,
    );
    assert.deepEqual(
      fs.readFileSync(argvCapture).toString().split("\0").slice(0, -1),
      entry.expectedArgs,
    );
    assert.equal(fs.existsSync(continued), false);
    assert.equal(fs.existsSync(globalMarker), false);
    assert.equal(fs.existsSync(injected), false);
    assert.equal(
      fs.readFileSync(sentinelCapture, "utf8"),
      entry.manager === "lefthook" ? "{files}" : "",
    );
  }
});

test("manager-composed hook entry points honor documented skip variables", () => {
  assert.equal(hooksDisabled({}), false);
  assert.equal(hooksDisabled({ COMMITMENT_ISSUES: "1", HUSKY: "1" }), false);
  assert.equal(hooksDisabled({ COMMITMENT_ISSUES: "0" }), true);
  assert.equal(hooksDisabled({ HUSKY: "0" }), true);
});

test("cleanup inspection recognizes pre-dispatch manager entries without treating them as healthy", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manager-cleanup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const names = ["pre-commit", "pre-push", "commit-msg"];
  const assertCleanupOnly = (manager) => {
    assert.equal(inspectHookManager(manager, names, dir).status, "missing");
    assert.equal(
      inspectHookManagerForCleanup(manager, names, dir).status,
      "wired",
    );
  };

  fs.mkdirSync(path.join(dir, ".husky"));
  for (const dispatcher of [" hook", ""]) {
    fs.writeFileSync(
      path.join(dir, ".husky", "pre-commit"),
      `node_modules/.bin/commitment-issues${dispatcher} precommit || exit $?\n`,
    );
    fs.writeFileSync(
      path.join(dir, ".husky", "pre-push"),
      `node_modules/.bin/commitment-issues${dispatcher} prepush "$@" || exit $?\n`,
    );
    fs.writeFileSync(
      path.join(dir, ".husky", "commit-msg"),
      `node_modules/.bin/commitment-issues${dispatcher} commit-msg "$1" || exit $?\n`,
    );
    assertCleanupOnly("husky");
  }

  for (const name of names) {
    fs.writeFileSync(
      path.join(dir, ".husky", name),
      `#!/bin/sh\necho existing\n${hookInvocation(name)}\n`,
    );
  }
  assertCleanupOnly("husky");

  const lefthookConfig = ({ dispatcher, sentinel }) =>
    [
      "pre-commit:",
      "  commands:",
      "    commitment-issues:",
      `      run: ${sentinel ? "COMMITMENT_ISSUES_LEFTHOOK_FILE={files} " : ""}node_modules/.bin/commitment-issues${dispatcher} precommit`,
      ...(sentinel
        ? [
            "      files: node -- node_modules/commitment-issues/scripts/lefthook-files.mjs",
          ]
        : []),
      "pre-push:",
      "  commands:",
      "    commitment-issues:",
      `      run: ${sentinel ? "COMMITMENT_ISSUES_LEFTHOOK_FILE={files} " : ""}node_modules/.bin/commitment-issues${dispatcher} prepush`,
      ...(sentinel
        ? [
            "      files: node -- node_modules/commitment-issues/scripts/lefthook-files.mjs",
          ]
        : []),
      "      use_stdin: true",
      "commit-msg:",
      "  commands:",
      "    commitment-issues:",
      `      run: node_modules/.bin/commitment-issues${dispatcher} commit-msg --git-path`,
      "",
    ].join("\n");
  for (const legacy of [
    { dispatcher: " hook", sentinel: true },
    { dispatcher: " hook", sentinel: false },
    { dispatcher: "", sentinel: false },
  ]) {
    fs.writeFileSync(path.join(dir, "lefthook.yml"), lefthookConfig(legacy));
    assertCleanupOnly("lefthook");
  }

  const preCommitConfig = (dispatcher) =>
    [
      "repos:",
      "  - repo: local",
      "    hooks:",
      "      - id: commitment-issues-pre-commit",
      "        name: commitment-issues pre-commit",
      `        entry: node_modules/.bin/commitment-issues${dispatcher} precommit`,
      "        language: system",
      "        pass_filenames: false",
      "        always_run: true",
      "        stages: [pre-commit]",
      "      - id: commitment-issues-pre-push",
      "        name: commitment-issues pre-push",
      `        entry: node_modules/.bin/commitment-issues${dispatcher} prepush`,
      "        language: system",
      "        pass_filenames: false",
      "        always_run: true",
      "        stages: [pre-push]",
      "      - id: commitment-issues-commit-msg",
      "        name: commitment-issues commit-msg",
      `        entry: node_modules/.bin/commitment-issues${dispatcher} commit-msg`,
      "        language: system",
      "        pass_filenames: true",
      "        always_run: true",
      "        stages: [commit-msg]",
      "",
    ].join("\n");
  for (const dispatcher of [" hook", ""]) {
    fs.writeFileSync(
      path.join(dir, ".pre-commit-config.yaml"),
      preCommitConfig(dispatcher),
    );
    assertCleanupOnly("pre-commit");
  }
});

test("Husky inspection inventories legacy duplicates and cross-stage commands", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "husky-inventory-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".husky"));

  const preCommit = path.join(dir, ".husky", "pre-commit");
  fs.writeFileSync(
    preCommit,
    [
      "#!/bin/sh",
      hookInvocation("pre-commit"),
      "node_modules/.bin/commitment-issues precommit || exit $?",
      "",
    ].join("\n"),
  );
  assert.deepEqual(inspectHookManager("husky", ["pre-commit"], dir).hooks, [
    { name: "pre-commit", status: "duplicate" },
  ]);

  for (const invalidBody of [
    `#!/bin/sh\r${hookInvocation("pre-commit")}\r`,
    `#!/bin/sh\n${hookInvocation("pre-commit")}\nif\n`,
  ]) {
    fs.writeFileSync(preCommit, invalidBody);
    assert.deepEqual(inspectHookManager("husky", ["pre-commit"], dir).hooks, [
      { name: "pre-commit", status: "missing" },
    ]);
  }

  fs.writeFileSync(
    preCommit,
    [
      "#!/bin/sh",
      hookInvocation("pre-commit"),
      hookInvocation("pre-commit"),
      "",
    ].join("\n"),
  );
  assert.deepEqual(inspectHookManager("husky", ["pre-commit"], dir).hooks, [
    { name: "pre-commit", status: "duplicate" },
  ]);

  fs.writeFileSync(
    preCommit,
    "#!/bin/sh\nnode_modules/.bin/commitment-issues precommit || exit $?\n",
  );
  assert.deepEqual(inspectHookManager("husky", ["pre-commit"], dir).hooks, [
    { name: "pre-commit", status: "legacy" },
  ]);
  assert.equal(
    inspectHookManagerForCleanup("husky", ["pre-commit"], dir).status,
    "wired",
  );

  const prePush = path.join(dir, ".husky", "pre-push");
  for (const crossStage of [
    "node_modules/.bin/commitment-issues precommit || exit $?",
    hookInvocation("pre-commit"),
  ]) {
    fs.writeFileSync(
      prePush,
      ["#!/bin/sh", hookInvocation("pre-push"), crossStage, ""].join("\n"),
    );
    assert.deepEqual(inspectHookManager("husky", ["pre-push"], dir).hooks, [
      { name: "pre-push", status: "cross-stage" },
    ]);
  }

  fs.writeFileSync(
    prePush,
    [
      "#!/bin/sh",
      hookInvocation("pre-push"),
      "# node_modules/.bin/commitment-issues precommit || exit $?",
      "printf '%s\\n' 'node_modules/.bin/commitment-issues precommit || exit $?'",
      "cat <<'DOC'",
      "node_modules/.bin/commitment-issues precommit || exit $?",
      "DOC",
      "",
    ].join("\n"),
  );
  assert.equal(inspectHookManager("husky", ["pre-push"], dir).status, "wired");
});

test("Lefthook inspection inventories commands independently of command keys", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lefthook-inventory-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const names = ["pre-commit", "pre-push"];
  const snippets = hookManagerSnippets("lefthook", names);
  const canonical = snippets.map(({ content }) => content).join("\n");
  const currentPreCommit = snippets[0].content.match(/^\s+run: (.+)$/mu)[1];
  const legacyPreCommit = "node_modules/.bin/commitment-issues precommit";

  fs.writeFileSync(
    path.join(dir, "lefthook.yml"),
    canonical.replace(
      "pre-commit:\n",
      `pre-commit:\n  setup:\n    - run: ${legacyPreCommit}\n`,
    ),
  );
  assert.deepEqual(inspectHookManager("lefthook", names, dir).hooks[0], {
    name: "pre-commit",
    status: "duplicate",
  });

  fs.writeFileSync(
    path.join(dir, "lefthook.yml"),
    canonical.replace(
      "pre-commit:\n",
      `pre-commit:\n  setup:\n    - run: ${currentPreCommit}\n`,
    ),
  );
  assert.deepEqual(inspectHookManager("lefthook", names, dir).hooks[0], {
    name: "pre-commit",
    status: "duplicate",
  });

  for (const extraBlock of [
    [
      "  scripts:",
      "    duplicate-current.sh:",
      `      runner: ${currentPreCommit}`,
    ],
    [
      "  jobs:",
      `    - run: ${currentPreCommit}`,
      "      skip: true",
      "    - group:",
      "        jobs:",
      `          - run: ${currentPreCommit}`,
    ],
  ]) {
    fs.writeFileSync(
      path.join(dir, "lefthook.yml"),
      canonical.replace(
        "pre-commit:\n",
        ["pre-commit:", ...extraBlock, ""].join("\n"),
      ),
    );
    assert.deepEqual(inspectHookManager("lefthook", names, dir).hooks[0], {
      name: "pre-commit",
      status: "duplicate",
    });
  }

  for (const crossStage of [legacyPreCommit, currentPreCommit]) {
    fs.writeFileSync(
      path.join(dir, "lefthook.yml"),
      canonical.replace(
        "pre-push:\n",
        `pre-push:\n  setup:\n    - run: ${crossStage}\n`,
      ),
    );
    assert.deepEqual(inspectHookManager("lefthook", names, dir).hooks[1], {
      name: "pre-push",
      status: "cross-stage",
    });
  }

  fs.writeFileSync(
    path.join(dir, "lefthook.yml"),
    [
      "pre-push:",
      "  commands:",
      "    misplaced:",
      `      run: ${currentPreCommit}`,
      "",
    ].join("\n"),
  );
  assert.deepEqual(inspectHookManager("lefthook", ["pre-push"], dir).hooks[0], {
    name: "pre-push",
    status: "cross-stage",
    needsOwnStageEntry: true,
  });

  fs.writeFileSync(
    path.join(dir, "lefthook.yml"),
    [
      "pre-commit:",
      "  commands:",
      "    renamed-entry:",
      `      run: ${legacyPreCommit}`,
      "",
    ].join("\n"),
  );
  assert.deepEqual(inspectHookManager("lefthook", ["pre-commit"], dir).hooks, [
    { name: "pre-commit", status: "legacy" },
  ]);
  assert.equal(
    inspectHookManagerForCleanup("lefthook", ["pre-commit"], dir).status,
    "wired",
  );

  fs.writeFileSync(
    path.join(dir, "lefthook.yml"),
    canonical.replace(
      "pre-commit:\n",
      [
        "pre-commit:",
        "  scripts:",
        "    ignored-legacy.sh:",
        `      runner: ${legacyPreCommit}`,
        "      only: false",
        "",
      ].join("\n"),
    ),
  );
  assert.equal(inspectHookManager("lefthook", names, dir).status, "wired");
});

test("pre-commit inspection inventories commands independently of hook ids", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pre-commit-inventory-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const names = ["pre-commit", "pre-push"];
  const snippets = hookManagerSnippets("pre-commit", names);
  const canonical = `repos:\n  - repo: local\n    hooks:\n${snippets
    .map(({ content }) => content)
    .join("")}`;
  const currentPreCommit = snippets[0].content.match(/^\s+entry: (.+)$/mu)[1];
  const legacyPreCommit = "node_modules/.bin/commitment-issues precommit";
  const extraHook = ({
    id,
    entry = legacyPreCommit,
    language = "system",
    stages = "pre-commit",
  }) =>
    [
      `      - id: ${id}`,
      `        name: ${id}`,
      `        entry: ${entry}`,
      `        language: ${language}`,
      `        stages: [${stages}]`,
      "",
    ].join("\n");

  fs.writeFileSync(
    path.join(dir, ".pre-commit-config.yaml"),
    `${canonical}${extraHook({ id: "renamed-legacy" })}`,
  );
  assert.deepEqual(inspectHookManager("pre-commit", names, dir).hooks[0], {
    name: "pre-commit",
    status: "duplicate",
  });

  fs.writeFileSync(
    path.join(dir, ".pre-commit-config.yaml"),
    `${canonical}${extraHook({
      id: "renamed-current",
      entry: currentPreCommit,
    })}`,
  );
  assert.deepEqual(inspectHookManager("pre-commit", names, dir).hooks[0], {
    name: "pre-commit",
    status: "duplicate",
  });

  for (const entry of [legacyPreCommit, currentPreCommit]) {
    fs.writeFileSync(
      path.join(dir, ".pre-commit-config.yaml"),
      `${canonical}${extraHook({ id: "cross-stage", entry, stages: "pre-push" })}`,
    );
    assert.deepEqual(inspectHookManager("pre-commit", names, dir).hooks[1], {
      name: "pre-push",
      status: "cross-stage",
    });
  }

  fs.writeFileSync(
    path.join(dir, ".pre-commit-config.yaml"),
    `repos:\n  - repo: local\n    hooks:\n${extraHook({
      id: "misplaced-only",
      entry: currentPreCommit,
      stages: "pre-push",
    })}`,
  );
  assert.deepEqual(
    inspectHookManager("pre-commit", ["pre-push"], dir).hooks[0],
    {
      name: "pre-push",
      status: "cross-stage",
      needsOwnStageEntry: true,
    },
  );

  const renamedOnly = `repos:\n  - repo: local\n    hooks:\n${extraHook({
    id: "renamed-only",
  })}`;
  fs.writeFileSync(path.join(dir, ".pre-commit-config.yaml"), renamedOnly);
  assert.deepEqual(
    inspectHookManager("pre-commit", ["pre-commit"], dir).hooks,
    [{ name: "pre-commit", status: "legacy" }],
  );
  assert.equal(
    inspectHookManagerForCleanup("pre-commit", ["pre-commit"], dir).status,
    "wired",
  );

  fs.writeFileSync(
    path.join(dir, ".pre-commit-config.yaml"),
    `${canonical}${extraHook({ id: "inert-language", language: "fail" })}${extraHook(
      { id: "inert-stage", stages: "manual" },
    )}`,
  );
  assert.equal(inspectHookManager("pre-commit", names, dir).status, "wired");
});

test("Husky integration inspection accepts only active exact invocations", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "husky-inspect-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "husky-outside-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".husky"));

  assert.equal(
    inspectHookManager("husky", ["pre-commit"], dir).status,
    "missing",
  );
  fs.writeFileSync(
    path.join(dir, ".husky", "pre-commit"),
    [
      "#!/bin/sh",
      "# node_modules/.bin/commitment-issues hook precommit",
      hookInvocation("pre-commit"),
      "echo existing hook",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, ".husky", "pre-push"),
    `${hookInvocation("pre-push")}\n`,
  );
  fs.writeFileSync(
    path.join(dir, ".husky", "commit-msg"),
    `${hookInvocation("commit-msg")}\n`,
  );
  assert.equal(
    inspectHookManager("husky", ["pre-commit"], dir).status,
    "wired",
  );
  assert.equal(inspectHookManager("husky", ["pre-push"], dir).status, "wired");
  assert.equal(
    inspectHookManager("husky", ["commit-msg"], dir).status,
    "wired",
  );

  fs.writeFileSync(
    path.join(dir, ".husky", "pre-commit"),
    "node_modules/.bin/commitment-issues precommit || exit $?\n",
  );
  assert.equal(
    inspectHookManager("husky", ["pre-commit"], dir).status,
    "missing",
  );

  fs.writeFileSync(
    path.join(outside, "pre-push"),
    'node_modules/.bin/commitment-issues hook prepush "$@" || exit $?\n',
  );
  fs.rmSync(path.join(dir, ".husky", "pre-push"));
  fs.symlinkSync(
    path.join(outside, "pre-push"),
    path.join(dir, ".husky", "pre-push"),
  );
  assert.equal(
    inspectHookManager("husky", ["pre-push"], dir).status,
    "uninspectable",
  );

  fs.writeFileSync(
    path.join(dir, ".husky", "pre-commit"),
    'example="\nnode_modules/.bin/commitment-issues hook precommit\n"\n',
  );
  assert.equal(
    inspectHookManager("husky", ["pre-commit"], dir).status,
    "missing",
  );

  const invocation = hookInvocation("pre-commit");
  for (const content of [
    ["#!/bin/sh", "false &&", invocation, ""].join("\n"),
    ["#!/bin/sh", "true ||", invocation, ""].join("\n"),
    ["#!/bin/sh", "value=$(", invocation, ")", ""].join("\n"),
    ["#!/bin/sh", "true; if false; then", invocation, "fi", ""].join("\n"),
    ["#!/bin/sh", "check() { # helper", invocation, "}", ""].join("\n"),
    ["#!/bin/sh", "set -n", invocation, ""].join("\n"),
  ]) {
    fs.writeFileSync(path.join(dir, ".husky", "pre-commit"), content);
    assert.equal(
      inspectHookManager("husky", ["pre-commit"], dir).status,
      "missing",
      content,
    );
  }
});

test("Husky v9 rejects a stale v8 source prelude that breaks the real hook", (t) => {
  const dir = createTempRepo();
  t.after(() => cleanupTempRepo(dir));
  run("git", ["config", "core.hooksPath", ".husky/_"], dir);
  const runtimeDir = path.join(dir, ".husky", "_");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, "h"), HUSKY_V9_RUNTIME);
  const wrapper = path.join(runtimeDir, "pre-commit");
  fs.writeFileSync(wrapper, '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n', {
    mode: 0o755,
  });
  fs.writeFileSync(
    path.join(dir, ".husky", "pre-commit"),
    [
      "#!/usr/bin/env sh",
      '. "$(dirname -- "$0")/_/husky.sh"',
      hookInvocation("pre-commit"),
      "",
    ].join("\n"),
  );

  assert.equal(
    inspectHookManager("husky", ["pre-commit"], dir).status,
    "missing",
  );
  assert.equal(
    inspectHookManagerRunner("husky", ["pre-commit"], dir).status,
    "wired",
  );

  const executed = run("sh", [wrapper], dir);
  assert.notEqual(executed.status, 0);
  assert.match(`${executed.stdout}${executed.stderr}`, /husky\.sh/u);
});

test("Lefthook integration inspection requires the command and pre-push stdin", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lefthook-inspect-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const names = ["pre-commit", "pre-push", "commit-msg"];

  assert.equal(inspectHookManager("lefthook", names, dir).status, "missing");
  const snippets = hookManagerSnippets("lefthook", names);
  fs.writeFileSync(
    path.join(dir, "lefthook.yml"),
    `# existing commands stay before ours\n${snippets.map(({ content }) => content).join("\n")}`,
  );
  assert.equal(inspectHookManager("lefthook", names, dir).status, "wired");

  const opaqueFlowCommand = [
    "pre-commit:",
    "  commands:",
    "    commitment-issues:",
    '      { "r\\u0075n": "COMMITMENT_ISSUES_LEFTHOOK_FILE={files} node_modules/.bin/commitment-issues hook precommit", files: "node -- node_modules/commitment-issues/scripts/lefthook-files.mjs" }',
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "lefthook.yml"), opaqueFlowCommand);
  assert.equal(
    inspectHookManager("lefthook", ["pre-commit"], dir).status,
    "missing",
  );

  const canonical = snippets.map(({ content }) => content).join("\n");
  for (const commentedStructure of [
    canonical.replace("  commands:\n", "  commands: # managed\n"),
    canonical.replace("  commands:\n", "  commands :\n"),
    canonical.replace(
      "  commands:\n",
      "  setup:\n  - run: echo setup\n  commands:\n",
    ),
    canonical.replace(
      "    commitment-issues:\n",
      "    commitment-issues: # managed\n",
    ),
  ]) {
    fs.writeFileSync(path.join(dir, "lefthook.yml"), commentedStructure);
    assert.equal(
      inspectHookManager("lefthook", names, dir).status,
      "missing",
      commentedStructure,
    );
  }

  fs.writeFileSync(
    path.join(dir, "lefthook.yml"),
    snippets
      .map(({ content }) => content)
      .join("\n")
      .replace("      use_stdin: true\n", "      use_stdin: false\n"),
  );
  const noStdin = inspectHookManager("lefthook", names, dir);
  assert.equal(noStdin.status, "missing");
  assert.deepEqual(
    noStdin.hooks.filter(({ status }) => status !== "wired"),
    [{ name: "pre-push", status: "missing" }],
  );

  for (const unsafeEmptyHookContract of [
    canonical.replace("COMMITMENT_ISSUES_LEFTHOOK_FILE={files} ", ""),
    canonical.replace(
      "files: node -- node_modules/commitment-issues/scripts/lefthook-files.mjs",
      "files: git diff --name-only --cached",
    ),
  ]) {
    fs.writeFileSync(path.join(dir, "lefthook.yml"), unsafeEmptyHookContract);
    assert.equal(
      inspectHookManager("lefthook", names, dir).status,
      "missing",
      unsafeEmptyHookContract,
    );
  }

  fs.writeFileSync(
    path.join(dir, "lefthook.yml"),
    snippets
      .map(({ content }) => content)
      .join("\n")
      .replace("prepush", 'prepush "{1}" "{2}"'),
  );
  assert.deepEqual(
    inspectHookManager("lefthook", names, dir).hooks.filter(
      ({ status }) => status !== "wired",
    ),
    [{ name: "pre-push", status: "missing" }],
  );

  fs.writeFileSync(
    path.join(dir, "lefthook.yml"),
    snippets
      .map(({ content }) => content)
      .join("\n")
      .replace("commit-msg --git-path", 'commit-msg "{1}"'),
  );
  assert.deepEqual(
    inspectHookManager("lefthook", names, dir).hooks.filter(
      ({ status }) => status !== "wired",
    ),
    [{ name: "commit-msg", status: "missing" }],
  );

  fs.writeFileSync(
    path.join(dir, "lefthook.yml"),
    snippets
      .map(({ content }) => content)
      .join("\n")
      .replace("    commitment-issues:\n", "    other-command:\n"),
  );
  assert.equal(inspectHookManager("lefthook", names, dir).status, "missing");

  fs.writeFileSync(
    path.join(dir, "lefthook.yml"),
    [
      "pre-commit:",
      "  examples:",
      "    commitment-issues:",
      "      run: node_modules/.bin/commitment-issues hook precommit",
      "",
    ].join("\n"),
  );
  assert.equal(
    inspectHookManager("lefthook", ["pre-commit"], dir).status,
    "uninspectable",
  );

  fs.writeFileSync(
    path.join(dir, "lefthook.yml"),
    [
      "pre-commit:",
      "  commands:",
      "    commitment-issues:",
      "      notes: |",
      "        run: node_modules/.bin/commitment-issues hook precommit",
      "",
    ].join("\n"),
  );
  assert.equal(
    inspectHookManager("lefthook", ["pre-commit"], dir).status,
    "uninspectable",
  );

  fs.writeFileSync(
    path.join(dir, "lefthook.yml"),
    [
      "pre-commit:",
      "  commands:",
      "    commitment-issues:",
      "      run: node_modules/.bin/commitment-issues hook precommit",
      "      run: echo duplicate",
      "",
    ].join("\n"),
  );
  assert.equal(
    inspectHookManager("lefthook", ["pre-commit"], dir).status,
    "uninspectable",
  );

  fs.writeFileSync(
    path.join(dir, "lefthook.yml"),
    ["pre-commit:", "  commands:", "    commitment-issues: {}", ""].join("\n"),
  );
  assert.equal(
    inspectHookManager("lefthook", ["pre-commit"], dir).status,
    "uninspectable",
  );

  const completeConfig = snippets.map(({ content }) => content).join("\n");
  const controlledConfig = completeConfig.replace(
    "pre-commit:\n",
    [
      "pre-commit:",
      "  parallel: true",
      "  piped: false",
      "  follow: true",
      "  fail_on_changes: never",
      "  fail_on_changes_diff: false",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "lefthook.yml"), controlledConfig);
  assert.equal(inspectHookManager("lefthook", names, dir).status, "wired");

  for (const disabled of [
    snippets[0].content.replace("  commands:", "  skip: True\n  commands:"),
    snippets[0].content.replace("  commands:", "  only: [merge]\n  commands:"),
    snippets[0].content.replace(
      "  commands:",
      "  files: printf ''\n  commands:",
    ),
    snippets[0].content.replace(
      "  commands:",
      "  exclude: [never-match]\n  commands:",
    ),
    snippets[0].content.replace(
      "      run:",
      "      glob: NEVER_MATCH_*.js\n      run:",
    ),
    snippets[0].content.replace(
      "      run:",
      "      env:\n        COMMITMENT_ISSUES: '0'\n      run:",
    ),
  ]) {
    fs.writeFileSync(path.join(dir, "lefthook.yml"), disabled);
    assert.equal(
      inspectHookManager("lefthook", ["pre-commit"], dir).status,
      "missing",
      disabled,
    );
  }

  for (const unsupported of [
    '  glob: "*.never"',
    "  file_types: [unknown]",
    "  root: missing/",
    "  env: { COMMITMENT_ISSUES: '0' }",
    "  future_option: true",
  ]) {
    const configWithUnsupportedHookOption = snippets[0].content.replace(
      "  commands:",
      `${unsupported}\n  commands:`,
    );
    fs.writeFileSync(
      path.join(dir, "lefthook.yml"),
      configWithUnsupportedHookOption,
    );
    assert.equal(
      inspectHookManager("lefthook", ["pre-commit"], dir).status,
      "uninspectable",
      configWithUnsupportedHookOption,
    );
  }

  const inheritedSkip = `defaults: &disabled\n  skip: true\n${snippets[0].content.replace(
    "      run:",
    "      <<: *disabled\n      run:",
  )}`;
  fs.writeFileSync(path.join(dir, "lefthook.yml"), inheritedSkip);
  assert.equal(
    inspectHookManager("lefthook", ["pre-commit"], dir).status,
    "uninspectable",
    inheritedSkip,
  );

  for (const inherited of [
    "extends :\n  - other.yml\n",
    "remotes:\n  - git_url: example\n",
    "min_version: 999.0.0\n",
    "rc: ./disable-commitment-issues.sh\n",
    "lefthook: /usr/bin/false\n",
    "source_dir: .other-hooks/\n",
    "templates: { runner: false }\n",
    "colors: false\n",
    "glob_matcher: doublestar\n",
    "assert_lefthook_installed: true\n",
    "output: [summary]\n",
    "no_tty: true\n",
    "skip_lfs: true\n",
    "future_global_option: true\n",
  ]) {
    fs.writeFileSync(
      path.join(dir, "lefthook.yml"),
      `${inherited}${completeConfig}`,
    );
    assert.equal(
      inspectHookManager("lefthook", names, dir).status,
      "uninspectable",
      inherited,
    );
  }

  fs.writeFileSync(
    path.join(dir, "lefthook.yml"),
    `---\n${completeConfig}...\n`,
  );
  assert.equal(inspectHookManager("lefthook", names, dir).status, "wired");

  for (const unrelated of [
    "post-commit: banana\n",
    "post-commit:\n  commands: banana\n",
    "post-commit:\n  scripts: banana\n",
    "post-commit:\n  jobs: {}\n",
    "post-commit:\n  commands:\n    existing: banana\n",
    "post-commit:\n  commands:\n    existing: {}\n",
    "post-commit:\n  commands:\n    existing:\n      run: 1\n",
    "post-commit:\n  commands:\n    existing:\n      future: true\n",
    "post-commit:\n  scripts:\n    existing: banana\n",
    "post-commit:\n  jobs:\n    - banana\n",
    "post-commit:\n  jobs:\n    - {}\n",
    "post-commit:\n  jobs:\n    - run: 1\n",
    "post-commit:\n  parallel: banana\n",
    "post-commit:\n  files: []\n",
    "post-commit:\n  future: true\n",
    "post-commit:\n  commands:\n    existing:\n      run: echo ok\n      timeout: tomorrow\n",
    "post-commit:\n  jobs:\n    - run: echo ok\n      priority: 9007199254740992\n",
  ]) {
    fs.writeFileSync(
      path.join(dir, "lefthook.yml"),
      `${unrelated}${completeConfig}`,
    );
    assert.equal(
      inspectHookManager("lefthook", names, dir).status,
      "uninspectable",
      unrelated,
    );
  }

  fs.writeFileSync(
    path.join(dir, "lefthook.yml"),
    [
      "post-commit:",
      "  parallel: true",
      "  piped: false",
      "  follow: true",
      "  fail_on_changes: ci",
      "  fail_on_changes_diff: false",
      "  files: git diff --name-only",
      "  exclude_tags: [slow]",
      "  exclude: [vendor]",
      "  skip: [merge]",
      "  only: [ref:main]",
      "  setup:",
      "    - run: echo setup",
      "  commands:",
      "    existing:",
      "      run: echo existing",
      "      files: changed.txt",
      "      root: .",
      "      fail_text: failed",
      "      skip: false",
      "      only: [merge]",
      "      tags: [fast]",
      "      file_types: text",
      "      glob: '*.js'",
      "      exclude: [vendor]",
      "      env: { MODE: test }",
      "      priority: 1",
      "      interactive: false",
      "      use_stdin: false",
      "      stage_fixed: false",
      "  scripts:",
      "    existing.sh:",
      "      runner: sh",
      "      args: --check",
      "      skip: false",
      "      only: [merge]",
      "      tags: fast",
      "      env: { MODE: test }",
      "      priority: 2",
      "      fail_text: failed",
      "      interactive: false",
      "      use_stdin: false",
      "      stage_fixed: false",
      "  jobs:",
      "    - name: command",
      "      run: echo job",
      "      runner: sh",
      "      args: --check",
      "      root: .",
      "      files: changed.txt",
      "      fail_text: failed",
      "      glob: '*.js'",
      "      exclude: [vendor]",
      "      tags: [fast]",
      "      file_types: text",
      "      env: { MODE: test }",
      "      interactive: false",
      "      use_stdin: false",
      "      stage_fixed: false",
      "      skip: false",
      "      only: [merge]",
      "    - script: existing.sh",
      "    - group:",
      "        root: .",
      "        parallel: false",
      "        piped: true",
      "        jobs:",
      "          - run: echo nested",
      completeConfig.trimEnd(),
      "",
    ].join("\n"),
  );
  assert.equal(inspectHookManager("lefthook", names, dir).status, "wired");

  fs.writeFileSync(
    path.join(dir, "lefthook.yml"),
    `${completeConfig}\n${snippets[0].content}`,
  );
  assert.equal(
    inspectHookManager("lefthook", names, dir).status,
    "uninspectable",
  );

  fs.writeFileSync(path.join(dir, "lefthook.yaml"), "pre-commit: {}\n");
  assert.equal(
    inspectHookManager("lefthook", names, dir).status,
    "uninspectable",
  );
});

test("pre-commit integration inspection validates complete local hook entries", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pre-commit-inspect-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pre-commit-outside-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const names = ["pre-commit", "pre-push", "commit-msg"];
  const snippets = hookManagerSnippets("pre-commit", names);
  const config = `repos:\n  - repo: local\n    hooks:\n${snippets.map(({ content }) => content).join("")}`;
  fs.writeFileSync(path.join(dir, ".pre-commit-config.yaml"), config);
  assert.equal(inspectHookManager("pre-commit", names, dir).status, "wired");

  for (const commentedStructure of [
    config.replace("repos:\n", "repos: # managed\n"),
    config.replace("repos:\n", "repos :\n"),
    config.replace("    hooks:\n", "    hooks: # managed\n"),
    config.replace("    hooks:\n", "    hooks :\n"),
  ]) {
    fs.writeFileSync(
      path.join(dir, ".pre-commit-config.yaml"),
      commentedStructure,
    );
    assert.equal(
      inspectHookManager("pre-commit", names, dir).status,
      "missing",
      commentedStructure,
    );
  }

  const targetHook = {
    id: "commitment-issues-pre-commit",
    name: "commitment-issues pre-commit",
    entry: "node_modules/.bin/commitment-issues hook precommit",
    language: "system",
    pass_filenames: false,
    always_run: true,
    stages: ["pre-commit"],
  };
  for (const nonCanonicalStructure of [
    JSON.stringify({ repos: [{ repo: "local", hooks: [targetHook] }] }),
    [
      "repos:",
      "  - repo: local",
      `    hooks: [${JSON.stringify(targetHook)}]`,
      "",
    ].join("\n"),
    config.replace(
      "      - id: commitment-issues-pre-commit\n",
      '      - id: "commitment-issues-pre-commit"\n',
    ),
  ]) {
    fs.writeFileSync(
      path.join(dir, ".pre-commit-config.yaml"),
      nonCanonicalStructure,
    );
    assert.equal(
      inspectHookManager("pre-commit", ["pre-commit"], dir).status,
      "missing",
      nonCanonicalStructure,
    );
  }

  const configWithUnrelatedHooks = [
    "fail_fast: false",
    "default_install_hook_types: [pre-commit, pre-push, commit-msg]",
    "default_stages: [pre-commit, pre-push]",
    "default_language_version:",
    "  python: python3",
    "repos:",
    "  - repo: local",
    "    hooks:",
    "      - id: unrelated-local-hook",
    "        name: unrelated local hook",
    "        entry: python -m example",
    "        language: python",
    "        files: \\.py$",
    "        exclude: ^vendor/",
    "        types: [python]",
    "        types_or: [python, text]",
    "        exclude_types: [binary]",
    "        args: [--check]",
    ...snippets.flatMap(({ content }) => content.trimEnd().split("\n")),
    "  - repo: https://example.invalid/hooks",
    "    rev: v1.0.0",
    "    hooks:",
    "      - id: unrelated-remote-hook",
    "        args: [--strict]",
    "",
  ].join("\n");
  fs.writeFileSync(
    path.join(dir, ".pre-commit-config.yaml"),
    configWithUnrelatedHooks,
  );
  assert.equal(inspectHookManager("pre-commit", names, dir).status, "wired");

  fs.writeFileSync(
    path.join(dir, ".pre-commit-config.yaml"),
    `${config}  - repo: local\n    hooks:\n      - id: quoted-yaml-boolean\n        name: "yes"\n        entry: echo quoted\n        language: system\n`,
  );
  assert.equal(inspectHookManager("pre-commit", names, dir).status, "wired");

  const duplicateRemoteId = `${config}\n  - repo: https://example.invalid/hooks\n    rev: v1.0.0\n    hooks:\n      - id: commitment-issues-pre-commit\n`;
  fs.writeFileSync(
    path.join(dir, ".pre-commit-config.yaml"),
    duplicateRemoteId,
  );
  assert.equal(inspectHookManager("pre-commit", names, dir).status, "missing");

  fs.writeFileSync(
    path.join(dir, ".pre-commit-config.yaml"),
    config.replace("        always_run: true\n", "        always_run: false\n"),
  );
  assert.equal(inspectHookManager("pre-commit", names, dir).status, "missing");

  fs.writeFileSync(
    path.join(dir, ".pre-commit-config.yaml"),
    config
      .split("\n")
      .map((line) => `# ${line}`)
      .join("\n"),
  );
  assert.equal(
    inspectHookManager("pre-commit", names, dir).status,
    "uninspectable",
  );

  fs.writeFileSync(
    path.join(dir, ".pre-commit-config.yaml"),
    `examples:\n${snippets[0].content}`,
  );

  fs.writeFileSync(
    path.join(dir, ".pre-commit-config.yaml"),
    `example: |2\n${config
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n")}`,
  );
  assert.equal(
    inspectHookManager("pre-commit", ["pre-commit"], dir).status,
    "uninspectable",
  );

  const withArgs = config.replace(
    "        language: system\n",
    "        args: [--help]\n        language: system\n",
  );
  fs.writeFileSync(path.join(dir, ".pre-commit-config.yaml"), withArgs);
  assert.equal(inspectHookManager("pre-commit", names, dir).status, "missing");

  const targetWithExtraOption = config.replace(
    "        language: system\n",
    "        minimum_pre_commit_version: 999.0.0\n        language: system\n",
  );
  fs.writeFileSync(
    path.join(dir, ".pre-commit-config.yaml"),
    targetWithExtraOption,
  );
  assert.equal(
    inspectHookManager("pre-commit", ["pre-commit"], dir).status,
    "uninspectable",
  );

  const configWithMinimumVersion = `minimum_pre_commit_version: 3.2.0\n${config}`;
  fs.writeFileSync(
    path.join(dir, ".pre-commit-config.yaml"),
    configWithMinimumVersion,
  );
  assert.equal(inspectHookManager("pre-commit", names, dir).status, "wired");

  fs.writeFileSync(
    path.join(dir, ".pre-commit-config.yaml"),
    `minimum_pre_commit_version: "0.0"\n${config}`,
  );
  assert.equal(inspectHookManager("pre-commit", names, dir).status, "wired");

  for (const supportedTopLevel of [
    `minimum_pre_commit_version: "3.2"\n${config}`,
    `${String.raw`files: '\d+$'`}\n${config}`,
  ]) {
    fs.writeFileSync(
      path.join(dir, ".pre-commit-config.yaml"),
      supportedTopLevel,
    );
    assert.equal(
      inspectHookManager("pre-commit", names, dir).status,
      "wired",
      supportedTopLevel,
    );
  }

  for (const unsupported of [
    config.replace("        name: commitment-issues pre-commit\n", ""),
    config.replace(
      "        language: system\n",
      "        future_skip: true\n        language: system\n",
    ),
    config.replace("    hooks:\n", "    rev: v1\n    hooks:\n"),
  ]) {
    fs.writeFileSync(path.join(dir, ".pre-commit-config.yaml"), unsupported);
    assert.equal(
      inspectHookManager("pre-commit", ["pre-commit"], dir).status,
      "uninspectable",
      unsupported,
    );
  }

  for (const changed of [
    config.replace(
      "        always_run: true\n",
      '        always_run: true\n        "always_run" : false\n',
    ),
    config.replace(
      "        stages: [pre-commit]\n",
      '        stages: [pre-commit]\n        "stages": [manual]\n',
    ),
    `${config}\n"repos": []\n`,
  ]) {
    fs.writeFileSync(path.join(dir, ".pre-commit-config.yaml"), changed);
    assert.equal(
      inspectHookManager("pre-commit", names, dir).status,
      "uninspectable",
      changed,
    );
  }
  assert.equal(
    inspectHookManager("pre-commit", ["pre-commit"], dir).status,
    "uninspectable",
  );

  fs.writeFileSync(
    path.join(dir, ".pre-commit-config.yaml"),
    [
      "repos:",
      "  - repo: local",
      "    hooks:",
      "      - id: commitment-issues-pre-commit",
      "        notes: |",
      "          entry: node_modules/.bin/commitment-issues hook precommit",
      "          language: system",
      "          pass_filenames: false",
      "          always_run: true",
      "          stages: [pre-commit]",
      "",
    ].join("\n"),
  );
  assert.equal(
    inspectHookManager("pre-commit", ["pre-commit"], dir).status,
    "uninspectable",
  );

  fs.writeFileSync(
    path.join(dir, ".pre-commit-config.yaml"),
    `${config.replace(
      "        language: system\n",
      "        entry: echo duplicate\n        language: system\n",
    )}`,
  );
  assert.equal(
    inspectHookManager("pre-commit", names, dir).status,
    "uninspectable",
  );

  fs.writeFileSync(
    path.join(dir, ".pre-commit-config.yaml"),
    config.replace(
      "        name: commitment-issues pre-commit\n",
      "        id: duplicate-id\n        name: commitment-issues pre-commit\n",
    ),
  );
  assert.equal(
    inspectHookManager("pre-commit", names, dir).status,
    "uninspectable",
  );

  fs.writeFileSync(
    path.join(dir, ".pre-commit-config.yaml"),
    "repos:\n  - repo: local\n    examples: []\n",
  );
  assert.equal(
    inspectHookManager("pre-commit", ["pre-commit"], dir).status,
    "uninspectable",
  );

  fs.writeFileSync(
    path.join(dir, ".pre-commit-config.yaml"),
    `${config}  - repo: local\n    hooks: banana\n`,
  );
  assert.equal(
    inspectHookManager("pre-commit", names, dir).status,
    "uninspectable",
  );

  fs.writeFileSync(
    path.join(dir, ".pre-commit-config.yaml"),
    `${config}  - repo: local\n    hooks:\n      - id: existing\n        name: existing\n        entry: echo existing\n        language: system\n`,
  );
  assert.equal(inspectHookManager("pre-commit", names, dir).status, "wired");

  fs.writeFileSync(
    path.join(dir, ".pre-commit-config.yaml"),
    [
      config.trimEnd(),
      "  - repo: https://example.com/hooks",
      "    rev: v1.0.0",
      "    hooks:",
      "      - id: remote-hook",
      "  - repo: meta",
      "    hooks:",
      "      - id: identity",
      "        language: system",
      "",
    ].join("\n"),
  );
  assert.equal(inspectHookManager("pre-commit", names, dir).status, "wired");

  for (const unrelated of [
    "  - repo: local\n    hooks:\n      - id: incomplete\n",
    "  - repo: local\n    rev: v1\n    hooks: []\n",
    "  - repo: https://example.com/hooks\n    hooks:\n      - id: remote-hook\n",
    "  - repo: meta\n    hooks:\n      - id: not-a-meta-hook\n",
    "  - repo: meta\n    hooks:\n      - id: identity\n        entry: echo replaced\n",
    "  - repo: meta\n    hooks:\n      - id: identity\n        language: future-language\n",
    "  - repo: local\n    hooks:\n      - id: invalid-language\n        name: invalid\n        entry: echo invalid\n        language: future-language\n",
    "  - repo: local\n    hooks:\n      - id: version-specific-language\n        name: invalid\n        entry: echo invalid\n        language: unsupported\n",
    "  - repo: local\n    hooks:\n      - id: invalid-type\n        name: invalid\n        entry: echo invalid\n        language: system\n        types: [not-a-real-type]\n",
    ...["pyi", "socket", "toml", "tsx", "vue"].map(
      (typeTag) =>
        `  - repo: local\n    hooks:\n      - id: version-specific-type-${typeTag}\n        name: invalid\n        entry: echo invalid\n        language: system\n        types: [${typeTag}]\n`,
    ),
    "  - repo: local\n    hooks:\n      - id: implicit-yaml-boolean\n        name: yes\n        entry: echo invalid\n        language: system\n",
    "  - repo: https://example.com/hooks\n    rev: 2024-01-01\n    hooks:\n      - id: implicit-yaml-date\n",
    "  - repo: local\n    hooks:\n      - id: implicit-yaml-integer\n        name: invalid\n        entry: echo invalid\n        language: system\n        language_version: 1:20\n",
    "  - repo: local\n    hooks:\n      - id: invalid-regex\n        name: invalid\n        entry: echo invalid\n        language: system\n        files: '(?P<python_only>.*)'\n",
    "  - repo: local\n    hooks:\n      - id: future-version\n        name: invalid\n        entry: echo invalid\n        language: system\n        minimum_pre_commit_version: 999.0.0\n",
  ]) {
    fs.writeFileSync(
      path.join(dir, ".pre-commit-config.yaml"),
      `${config}${unrelated}`,
    );
    assert.equal(
      inspectHookManager("pre-commit", names, dir).status,
      "uninspectable",
      unrelated,
    );
  }

  for (const unsupportedTopLevel of [
    `default_language_version:\n  future-language: default\n${config}`,
    `default_language_version:\n  system: default\n${config}`,
    `minimum_pre_commit_version: 03.2.0\n${config}`,
    `minimum_pre_commit_version: 3.2\n${config}`,
    `minimum_pre_commit_version: "3.2.0.0"\n${config}`,
    `minimum_pre_commit_version: "9007199254740992"\n${config}`,
    `default_install_hook_types: pre-commit\n${config}`,
    `default_install_hook_types: [pre-commit, future-hook]\n${config}`,
    `files: 7\n${config}`,
    `${String.raw`files: '\q'`}\n${config}`,
    `files: '['\n${config}`,
    `files: '[]'\n${config}`,
    `files: '[^]'\n${config}`,
    `files: '(?P<python_only>.*)'\n${config}`,
  ]) {
    fs.writeFileSync(
      path.join(dir, ".pre-commit-config.yaml"),
      unsupportedTopLevel,
    );
    assert.equal(
      inspectHookManager("pre-commit", names, dir).status,
      "uninspectable",
      unsupportedTopLevel,
    );
  }

  fs.writeFileSync(
    path.join(dir, ".pre-commit-config.yaml"),
    `${config}${snippets[0].content}`,
  );
  assert.equal(inspectHookManager("pre-commit", names, dir).status, "missing");

  fs.writeFileSync(path.join(outside, "config"), config);
  fs.rmSync(path.join(dir, ".pre-commit-config.yaml"));
  fs.symlinkSync(
    path.join(outside, "config"),
    path.join(dir, ".pre-commit-config.yaml"),
  );
  assert.equal(
    inspectHookManager("pre-commit", names, dir).status,
    "uninspectable",
  );
});

test("manager YAML inspection rejects malformed and advanced documents", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manager-yaml-safe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const names = ["pre-commit", "pre-push", "commit-msg"];
  const lefthook = hookManagerSnippets("lefthook", names)
    .map(({ content }) => content)
    .join("\n");
  const preCommit = hookManagerSnippets("pre-commit", names)
    .map(({ content }) => content)
    .join("\n");

  for (const content of [
    `broken: [\n${lefthook}`,
    `defaults: &d\n  extends: [override.yml]\n<<: *d\n${lefthook}`,
    `!!str extends: [override.yml]\n${lefthook}`,
    `? extends\n: [override.yml]\n${lefthook}`,
    `"\\u0065xtends": [override.yml]\n${lefthook}`,
    lefthook.replace("  commands:\n", '  "comm\\u0061nds":\n'),
  ]) {
    fs.writeFileSync(path.join(dir, "lefthook.yml"), content);
    assert.equal(
      inspectHookManager("lefthook", names, dir).status,
      "uninspectable",
      content,
    );
  }
  fs.rmSync(path.join(dir, "lefthook.yml"));

  for (const content of [
    `broken: [\n${preCommit}`,
    `!!str repos: []\n${preCommit}`,
    `? repos\n: []\n${preCommit}`,
    preCommit.replace(
      "        always_run: true\n",
      '        always_run: true\n        "alw\\u0061ys_run": false\n',
    ),
    preCommit.replace(
      "        language: system\n",
      '        "ar\\u0067s": [--help]\n        language: system\n',
    ),
  ]) {
    fs.writeFileSync(path.join(dir, ".pre-commit-config.yaml"), content);
    assert.equal(
      inspectHookManager("pre-commit", names, dir).status,
      "uninspectable",
      content,
    );
  }
});

test("Lefthook runner inspection refuses an environment-selected config", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-override-"));
  const hadOverride = Object.hasOwn(process.env, "LEFTHOOK_CONFIG");
  const originalOverride = process.env.LEFTHOOK_CONFIG;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.after(() => {
    if (hadOverride) process.env.LEFTHOOK_CONFIG = originalOverride;
    else delete process.env.LEFTHOOK_CONFIG;
  });
  process.env.LEFTHOOK_CONFIG = "custom/lefthook.toml";

  assert.deepEqual(inspectHookManager("lefthook", ["pre-commit"], dir), {
    manager: "lefthook",
    destination: null,
    status: "uninspectable",
    hooks: [{ name: "pre-commit", status: "uninspectable" }],
  });

  assert.deepEqual(inspectHookManagerRunner("lefthook", ["pre-commit"], dir), {
    manager: "lefthook",
    destination: "Git's effective hooks directory",
    status: "uninspectable",
    hooks: [{ name: "pre-commit", status: "uninspectable" }],
  });
});

test("Lefthook runner inspection rejects ambiguous config snapshots", (t) => {
  const dir = createTempRepo();
  const hooksDir = path.join(dir, ".git", "hooks");
  t.after(() => cleanupTempRepo(dir));
  fs.writeFileSync(path.join(dir, "lefthook.yml"), "pre-commit: {}\n");
  fs.writeFileSync(path.join(dir, ".lefthook.yml"), "pre-commit: {}\n");
  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    lefthookRunner("pre-commit"),
    { mode: 0o755 },
  );

  assert.deepEqual(inspectHookManagerRunner("lefthook", ["pre-commit"], dir), {
    manager: "lefthook",
    destination: "Git's effective hooks directory",
    status: "uninspectable",
    hooks: [{ name: "pre-commit", status: "uninspectable" }],
  });
});

test("Lefthook runner inspection rechecks its selected config", (t) => {
  const dir = createTempRepo();
  const configPath = path.join(dir, "lefthook.yml");
  const hooksDir = path.join(dir, ".git", "hooks");
  const originalRead = fs.readFileSync;
  let configReads = 0;
  t.after(() => cleanupTempRepo(dir));
  fs.writeFileSync(configPath, "pre-commit: {}\n");
  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    lefthookRunner("pre-commit"),
    { mode: 0o755 },
  );
  t.mock.method(fs, "readFileSync", (...args) => {
    if (path.resolve(String(args[0])) === configPath) {
      configReads += 1;
      if (configReads === 2) {
        throw Object.assign(new Error("injected config read failure"), {
          code: "EACCES",
        });
      }
    }
    return originalRead(...args);
  });

  assert.deepEqual(inspectHookManagerRunner("lefthook", ["pre-commit"], dir), {
    manager: "lefthook",
    destination: "Git's effective hooks directory",
    status: "uninspectable",
    hooks: [{ name: "pre-commit", status: "uninspectable" }],
  });
  assert.equal(configReads, 2);
});

test(
  "manager runtime discovery follows Git-for-Windows executable rules",
  { skip: process.platform === "win32" },
  (t) => {
    const dir = createTempRepo();
    const hooksDir = path.join(dir, ".git", "hooks");
    fs.rmSync(path.join(dir, "node_modules"));
    fs.mkdirSync(path.join(dir, "node_modules"));
    const runtimeBin = path.join(dir, ".windows-runtime");
    fs.mkdirSync(runtimeBin);
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    const originalPath = process.env.PATH;
    const hadLefthookBin = Object.hasOwn(process.env, "LEFTHOOK_BIN");
    const originalLefthookBin = process.env.LEFTHOOK_BIN;
    t.after(() => cleanupTempRepo(dir));
    t.after(() => {
      Object.defineProperty(process, "platform", platform);
      process.env.PATH = originalPath;
      if (hadLefthookBin) process.env.LEFTHOOK_BIN = originalLefthookBin;
      else delete process.env.LEFTHOOK_BIN;
    });

    Object.defineProperty(process, "platform", {
      configurable: true,
      enumerable: true,
      value: "win32",
    });
    process.env.PATH = `${runtimeBin}${path.delimiter}${originalPath}`;
    process.env.LEFTHOOK_BIN = "";
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      lefthookRunner("pre-commit"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(runtimeBin, "lefthook.exe"),
      "#!/bin/sh\nexit 0\n",
      {
        mode: 0o755,
      },
    );
    assert.equal(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
      "wired",
    );

    fs.rmSync(path.join(runtimeBin, "lefthook.exe"));
    const packagedLefthook = path.join(
      dir,
      "node_modules",
      `lefthook-windows-${process.arch}`,
      "bin",
      "lefthook.exe",
    );
    fs.mkdirSync(path.dirname(packagedLefthook), { recursive: true });
    fs.writeFileSync(packagedLefthook, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    assert.equal(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
      "wired",
    );

    fs.writeFileSync(path.join(dir, ".pre-commit-config.yaml"), "repos: []\n");
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      preCommitRunner("pre-commit", {
        installPython: "''",
        windowsLauncher: true,
      }).replaceAll("\n", "\r\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(runtimeBin, "pre-commit.exe"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );
    assert.equal(
      inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).status,
      "wired",
    );

    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      preCommitRunner("pre-commit", {
        installPython: "''",
        windowsLauncher: true,
      }).replaceAll("\n", "\r"),
      { mode: 0o755 },
    );
    assert.equal(
      inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).status,
      "foreign",
    );
  },
);

test(
  "Lefthook runtime discovery rejects filesystem ambiguity",
  {
    skip: process.platform === "win32",
  },
  (t) => {
    const dir = createTempRepo();
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "lefthook-runtime-fs-"),
    );
    const originalPath = process.env.PATH;
    const hadLefthookBin = Object.hasOwn(process.env, "LEFTHOOK_BIN");
    const originalLefthookBin = process.env.LEFTHOOK_BIN;
    t.after(() => cleanupTempRepo(dir));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    t.after(() => {
      process.env.PATH = originalPath;
      if (hadLefthookBin) process.env.LEFTHOOK_BIN = originalLefthookBin;
      else delete process.env.LEFTHOOK_BIN;
    });
    delete process.env.LEFTHOOK_BIN;
    fs.rmSync(path.join(dir, "node_modules"));
    fs.mkdirSync(path.join(dir, "node_modules"));

    const hooksDir = path.join(dir, ".git", "hooks");
    const isolatedPath = path.join(dir, ".runtime-git");
    fs.mkdirSync(isolatedPath);
    fs.symlinkSync(REAL_GIT, path.join(isolatedPath, "git"));
    process.env.PATH = isolatedPath;
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      lefthookRunner("pre-commit"),
      { mode: 0o755 },
    );
    const packaged = path.join(
      dir,
      "node_modules",
      `lefthook-${process.platform}-${process.arch}`,
      "bin",
      "lefthook",
    );
    fs.mkdirSync(path.dirname(packaged), { recursive: true });
    const reviewedTarget = path.join(outside, "lefthook");
    const foreignTarget = path.join(outside, "other-runtime");
    fs.writeFileSync(reviewedTarget, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(foreignTarget, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    let lstatError = null;
    let accessError = null;
    const faultPath = packaged;
    const originalLstatSync = fs.lstatSync;
    const originalAccessSync = fs.accessSync;
    t.mock.method(fs, "lstatSync", (filePath, ...args) => {
      if (
        path.resolve(String(filePath)) === path.resolve(faultPath) &&
        lstatError
      ) {
        throw Object.assign(new Error("injected runtime lstat failure"), {
          code: lstatError,
        });
      }
      return originalLstatSync(filePath, ...args);
    });
    t.mock.method(fs, "accessSync", (filePath, ...args) => {
      if (
        path.resolve(String(filePath)) === path.resolve(faultPath) &&
        accessError
      ) {
        throw Object.assign(new Error("injected runtime access failure"), {
          code: accessError,
        });
      }
      return originalAccessSync(filePath, ...args);
    });

    fs.symlinkSync(reviewedTarget, packaged);
    assert.equal(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
      "wired",
    );
    fs.rmSync(packaged);
    fs.symlinkSync(foreignTarget, packaged);
    assert.deepEqual(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "missing-runtime" }],
    );

    fs.rmSync(packaged);
    fs.writeFileSync(packaged, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    accessError = "EIO";
    assert.deepEqual(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "missing-runtime" }],
    );
    accessError = null;
    lstatError = "EIO";
    assert.deepEqual(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "missing-runtime" }],
    );
    lstatError = null;

    fs.rmSync(packaged);
    fs.mkdirSync(packaged);
    assert.deepEqual(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "missing-runtime" }],
    );
  },
);

test(
  "direct manager runtime lookup handles every PATH state fail-closed",
  {
    skip: process.platform === "win32",
  },
  (t) => {
    const dir = createTempRepo();
    const originalPath = process.env.PATH;
    t.after(() => cleanupTempRepo(dir));
    t.after(() => {
      process.env.PATH = originalPath;
    });
    const hooksDir = path.join(dir, ".git", "hooks");
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      '#!/bin/sh\nlefthook run "pre-commit"\n',
      { mode: 0o755 },
    );
    const relativeBin = path.join(dir, ".runtime-path");
    fs.mkdirSync(relativeBin);
    const candidate = path.join(relativeBin, "lefthook");
    fs.writeFileSync(candidate, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    process.env.PATH = `.runtime-path${path.delimiter}/usr/bin${path.delimiter}/bin`;
    assert.equal(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
      "wired",
    );

    fs.writeFileSync(path.join(dir, "lefthook"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    process.env.PATH = `${path.delimiter}/usr/bin${path.delimiter}/bin`;
    assert.equal(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
      "wired",
    );
    fs.rmSync(path.join(dir, "lefthook"));

    delete process.env.PATH;
    assert.deepEqual(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "missing-runtime" }],
    );
    fs.writeFileSync(path.join(dir, ".pre-commit-config.yaml"), "repos: []\n");
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      preCommitRunner("pre-commit", { installPython: "''" }),
      { mode: 0o755 },
    );
    assert.deepEqual(
      inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "missing-runtime" }],
    );
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      '#!/bin/sh\nlefthook run "pre-commit"\n',
      { mode: 0o755 },
    );

    const isolatedPath = path.join(dir, ".direct-runtime");
    fs.mkdirSync(isolatedPath);
    fs.symlinkSync(REAL_GIT, path.join(isolatedPath, "git"));
    process.env.PATH = isolatedPath;
    const directCandidate = path.join(isolatedPath, "lefthook");
    let lstatError = null;
    let accessError = null;
    const originalLstatSync = fs.lstatSync;
    const originalAccessSync = fs.accessSync;
    t.mock.method(fs, "lstatSync", (filePath, ...args) => {
      if (
        path.resolve(String(filePath)) === path.resolve(directCandidate) &&
        lstatError
      ) {
        throw Object.assign(new Error("injected PATH lstat failure"), {
          code: lstatError,
        });
      }
      return originalLstatSync(filePath, ...args);
    });
    t.mock.method(fs, "accessSync", (filePath, ...args) => {
      if (
        path.resolve(String(filePath)) === path.resolve(directCandidate) &&
        accessError
      ) {
        throw Object.assign(new Error("injected PATH access failure"), {
          code: accessError,
        });
      }
      return originalAccessSync(filePath, ...args);
    });

    fs.mkdirSync(directCandidate);
    assert.equal(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
      "missing",
    );
    fs.rmSync(directCandidate, { recursive: true });
    fs.writeFileSync(directCandidate, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    accessError = "EIO";
    assert.equal(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
      "missing",
    );
    accessError = null;
    for (const code of ["EACCES", "EIO"]) {
      lstatError = code;
      assert.equal(
        inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
        "missing",
      );
    }
  },
);

test("pre-commit runner words reject shell expansion and preserve safe quoting", (t) => {
  const dir = createTempRepo();
  t.after(() => cleanupTempRepo(dir));
  fs.writeFileSync(path.join(dir, ".pre-commit-config.yaml"), "repos: []\n");
  const hooksDir = path.join(dir, ".git", "hooks");
  const wrapper = path.join(hooksDir, "pre-commit");
  const python = path.join(dir, "vendor's", "python3");
  fs.mkdirSync(path.dirname(python));
  fs.writeFileSync(python, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  fs.writeFileSync(
    wrapper,
    preCommitRunner("pre-commit", {
      installPython: `vendor"'"s/python3`,
    }),
    { mode: 0o755 },
  );
  assert.equal(
    inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).status,
    "wired",
  );

  // Keep a literal short-name marker in the path so this covers Windows
  // runners whose temporary directory is spelled like RUNNER~1.
  const absolutePython = path.join(dir, "absolute~runtime", "python3");
  fs.mkdirSync(path.dirname(absolutePython));
  fs.writeFileSync(absolutePython, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    wrapper,
    preCommitRunner("pre-commit", {
      installPython: quoteShellWord(absolutePython.replaceAll("\\", "/")),
    }),
    { mode: 0o755 },
  );
  assert.equal(
    inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).status,
    "wired",
  );

  for (const content of [
    preCommitRunner("pre-commit", { installPython: "" }),
    preCommitRunner("pre-commit", { installPython: "'python3" }),
    preCommitRunner("pre-commit", {
      installPython: '"node_modules/$HOME/python3"',
    }),
    preCommitRunner("pre-commit", {
      installPython: "node_modules/.bin/python3;touch",
    }),
    preCommitRunner("pre-commit").replace(
      "INSTALL_PYTHON=",
      "PYTHON_EXECUTABLE=",
    ),
    preCommitRunner("pre-commit").replace(
      '    exec pre-commit "${ARGS[@]}"',
      '    pre-commit "${ARGS[@]}"',
    ),
  ]) {
    fs.writeFileSync(wrapper, content, { mode: 0o755 });
    assert.equal(
      inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).status,
      "foreign",
      content,
    );
  }
});

test("pre-commit runtime inspection fails closed after execute access succeeds", (t) => {
  const dir = createTempRepo();
  const originalPath = process.env.PATH;
  t.after(() => cleanupTempRepo(dir));
  t.after(() => {
    process.env.PATH = originalPath;
  });
  fs.writeFileSync(path.join(dir, ".pre-commit-config.yaml"), "repos: []\n");
  fs.rmSync(path.join(dir, "node_modules"));
  fs.mkdirSync(path.join(dir, "node_modules"));
  const hooksDir = path.join(dir, ".git", "hooks");
  const binDir = path.join(dir, "node_modules", ".bin");
  const fallbackDir = path.join(dir, ".runtime~fallback");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(fallbackDir);
  writeCrossPlatformShim(binDir, "python3", "process.exit(0);\n");
  writeCrossPlatformShim(fallbackDir, "pre-commit", "process.exit(0);\n");
  process.env.PATH = `${fallbackDir}${path.delimiter}${originalPath}`;
  const absolutePython = path.join(fallbackDir, "python3");
  writeCrossPlatformShim(fallbackDir, "python3", "process.exit(0);\n");
  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    preCommitRunner("pre-commit", {
      installPython: quoteShellWord(absolutePython.replaceAll("\\", "/")),
    }),
    { mode: 0o755 },
  );
  assert.equal(
    inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).status,
    "wired",
  );

  const gitOnlyPath = path.join(dir, ".git-only-path");
  fs.mkdirSync(gitOnlyPath);
  if (process.platform === "win32") {
    fs.writeFileSync(
      path.join(gitOnlyPath, "git.cmd"),
      `@"${REAL_GIT}" %*\r\n`,
    );
  } else {
    fs.symlinkSync(REAL_GIT, path.join(gitOnlyPath, "git"));
  }
  process.env.PATH = gitOnlyPath;
  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    preCommitRunner("pre-commit", {
      installPython: "missing/python3",
    }),
    { mode: 0o755 },
  );
  assert.deepEqual(
    inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).hooks,
    [{ name: "pre-commit", status: "missing-runtime" }],
  );
  process.env.PATH = `${fallbackDir}${path.delimiter}${originalPath}`;
  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    preCommitRunner("pre-commit", {
      installPython: "node_modules/.bin/python3",
    }),
    { mode: 0o755 },
  );

  const python = path.join(binDir, "python3");
  const originalLstatSync = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (filePath, ...args) => {
    if (path.resolve(String(filePath)) === path.resolve(python)) {
      throw Object.assign(new Error("injected post-access failure"), {
        code: "EIO",
      });
    }
    return originalLstatSync(filePath, ...args);
  });

  assert.deepEqual(
    inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).hooks,
    [{ name: "pre-commit", status: "missing-runtime" }],
  );
});

test("manager runner inspection verifies Git's effective executable wrappers", (t) => {
  const dir = createTempRepo();
  fs.rmSync(path.join(dir, "node_modules"), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "node_modules"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "manager-runner-"));
  const originalPath = process.env.PATH;
  const hadLefthookBin = Object.hasOwn(process.env, "LEFTHOOK_BIN");
  const originalLefthookBin = process.env.LEFTHOOK_BIN;
  t.after(() => cleanupTempRepo(dir));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  t.after(() => {
    process.env.PATH = originalPath;
    if (hadLefthookBin) process.env.LEFTHOOK_BIN = originalLefthookBin;
    else delete process.env.LEFTHOOK_BIN;
  });
  delete process.env.LEFTHOOK_BIN;
  const isolatedPath = path.join(dir, ".runner-path");
  const fallbackPath = path.join(dir, ".runner-fallback");
  fs.mkdirSync(isolatedPath);
  fs.mkdirSync(fallbackPath);
  if (process.platform === "win32") {
    fs.writeFileSync(
      path.join(isolatedPath, "git.cmd"),
      `@"${REAL_GIT}" %*\r\n`,
    );
  } else {
    fs.symlinkSync(REAL_GIT, path.join(isolatedPath, "git"));
  }
  process.env.PATH = isolatedPath;
  const hooksDir = path.join(dir, ".git", "hooks");
  const names = ["pre-commit", "pre-push", "commit-msg"];
  const binDir = path.join(dir, "node_modules", ".bin");
  const lefthookExecutable =
    process.platform === "win32" ? "lefthook.exe" : "lefthook";
  fs.mkdirSync(binDir, { recursive: true });
  writeCrossPlatformShim(
    binDir,
    lefthookExecutable,
    'process.exit(process.argv[2] === "-h" ? 0 : 17);\n',
  );
  writeCrossPlatformShim(binDir, "python3", "process.exit(0);\n");

  assert.equal(
    inspectHookManagerRunner("lefthook", names, dir).status,
    "missing",
  );
  for (const name of names) {
    fs.writeFileSync(path.join(hooksDir, name), lefthookRunner(name), {
      mode: 0o755,
    });
  }
  assert.equal(
    inspectHookManagerRunner("lefthook", names, dir).status,
    "wired",
  );
  if (process.platform !== "win32") {
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      lefthookRunner("pre-commit").replaceAll("\n", "\r\n"),
      { mode: 0o755 },
    );
    assert.deepEqual(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "foreign" }],
    );
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      lefthookRunner("pre-commit"),
      { mode: 0o755 },
    );
  }
  const runtimeMarker = path.join(dir, "lefthook-runtime-executed");
  writeCrossPlatformShim(
    binDir,
    lefthookExecutable,
    `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(runtimeMarker)}, "executed");\nprocess.exit(0);\n`,
  );
  assert.equal(
    inspectHookManagerRunner("lefthook", names, dir).status,
    "wired",
  );
  assert.equal(fs.existsSync(runtimeMarker), false);

  if (process.platform !== "win32") {
    fs.rmSync(path.join(binDir, "lefthook"));
    fs.symlinkSync(process.execPath, path.join(binDir, "lefthook"));
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      lefthookRunner("pre-commit"),
      { mode: 0o755 },
    );
    assert.deepEqual(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "missing-runtime" }],
    );
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      '#!/bin/sh\nexec node_modules/.bin/lefthook run "pre-commit"\n',
      { mode: 0o755 },
    );
    assert.deepEqual(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "missing-runtime" }],
    );
    fs.rmSync(path.join(binDir, "lefthook"));
    writeCrossPlatformShim(
      binDir,
      "lefthook",
      'process.exit(process.argv[2] === "-h" ? 0 : 17);\n',
    );
  }

  fs.rmSync(path.join(binDir, lefthookExecutable));
  fs.rmSync(path.join(binDir, `${lefthookExecutable}.cmd`));
  assert.deepEqual(
    inspectHookManagerRunner("lefthook", ["pre-commit"], dir).hooks,
    [{ name: "pre-commit", status: "missing-runtime" }],
  );
  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    lefthookRunner("pre-commit"),
    { mode: 0o755 },
  );
  assert.deepEqual(
    inspectHookManagerRunner("lefthook", ["pre-commit"], dir).hooks,
    [{ name: "pre-commit", status: "missing-runtime" }],
  );
  const fallbackDir = path.join(dir, "node_modules", "lefthook", "bin");
  fs.mkdirSync(fallbackDir, { recursive: true });
  writeCrossPlatformShim(
    fallbackDir,
    "index.js",
    'process.exit(process.argv[2] === "-h" ? 0 : 17);\n',
  );
  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    lefthookRunner("pre-commit", {
      embeddedExecutable: "/stale path/lefthook",
    }),
    { mode: 0o755 },
  );
  assert.equal(
    inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
    "foreign",
  );
  for (const direct of [
    '#!/bin/sh\nlefthook run "pre-commit"\n',
    '#!/bin/sh\nnode_modules/.bin/lefthook run "pre-commit"\n',
  ]) {
    fs.writeFileSync(path.join(hooksDir, "pre-commit"), direct, {
      mode: 0o755,
    });
    assert.deepEqual(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "missing-runtime" }],
      direct,
    );
  }
  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    lefthookRunner("pre-commit"),
    { mode: 0o755 },
  );
  if (process.platform !== "win32") {
    const runtimePlatform = process.platform;
    const earlierRuntime = path.join(
      dir,
      "node_modules",
      `lefthook-${runtimePlatform}-${process.arch}`,
      "bin",
      "lefthook",
    );
    fs.mkdirSync(path.dirname(earlierRuntime), { recursive: true });
    assert.equal(
      run("mkfifo", [earlierRuntime], dir, {
        env: { ...process.env, PATH: originalPath },
      }).status,
      0,
    );
    fs.chmodSync(earlierRuntime, 0o755);
    assert.equal(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
      "wired",
    );
    fs.rmSync(earlierRuntime);
    fs.writeFileSync(earlierRuntime, "not executable\n", { mode: 0o644 });
    assert.deepEqual(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "missing-runtime" }],
    );
    fs.rmSync(
      path.join(
        dir,
        "node_modules",
        `lefthook-${runtimePlatform}-${process.arch}`,
      ),
      {
        recursive: true,
      },
    );
  }
  assert.equal(
    inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
    "wired",
  );
  fs.rmSync(path.join(dir, "node_modules", "lefthook"), {
    recursive: true,
  });
  writeCrossPlatformShim(
    binDir,
    lefthookExecutable,
    'process.exit(process.argv[2] === "-h" ? 0 : 17);\n',
  );

  writeCrossPlatformShim(binDir, "false", "process.exit(1);\n");
  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    lefthookRunner("pre-commit", {
      embeddedExecutable: "node_modules/.bin/false",
    }),
    { mode: 0o755 },
  );
  assert.deepEqual(
    inspectHookManagerRunner("lefthook", ["pre-commit"], dir).hooks,
    [{ name: "pre-commit", status: "foreign" }],
  );

  writeCrossPlatformShim(outside, lefthookExecutable, "process.exit(0);\n");
  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    lefthookRunner("pre-commit", {
      embeddedExecutable: path
        .relative(dir, path.join(outside, lefthookExecutable))
        .replaceAll("\\", "/"),
    }),
    { mode: 0o755 },
  );
  assert.equal(
    inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
    "wired",
  );

  const unicodeRuntimeDir = path.join(outside, "unicodé-runtime");
  fs.mkdirSync(unicodeRuntimeDir);
  writeCrossPlatformShim(
    unicodeRuntimeDir,
    lefthookExecutable,
    "process.exit(0);\n",
  );
  const unicodeRuntime = path
    .relative(dir, path.join(unicodeRuntimeDir, lefthookExecutable))
    .replaceAll("\\", "/");
  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    lefthookRunner("pre-commit", { embeddedExecutable: unicodeRuntime }),
    { mode: 0o755 },
  );
  assert.equal(
    inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
    "wired",
  );

  if (process.platform !== "win32") {
    const assignmentRuntime = "LEFTHOOK_ALT=literal/lefthook";
    fs.mkdirSync(path.join(dir, "LEFTHOOK_ALT=literal"));
    fs.writeFileSync(path.join(dir, assignmentRuntime), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      lefthookRunner("pre-commit", {
        embeddedExecutable: assignmentRuntime,
      }),
      { mode: 0o755 },
    );
    assert.equal(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
      "foreign",
    );

    for (const metacharacter of ["|", "`"]) {
      const metacharacterRuntimeDir = path.join(
        outside,
        `shell${metacharacter}syntax`,
      );
      fs.mkdirSync(metacharacterRuntimeDir);
      writeCrossPlatformShim(
        metacharacterRuntimeDir,
        "lefthook",
        "process.exit(0);\n",
      );
      const metacharacterRuntime = path
        .join(metacharacterRuntimeDir, "lefthook")
        .replaceAll("\\", "/");
      fs.writeFileSync(
        path.join(hooksDir, "pre-commit"),
        lefthookRunner("pre-commit", {
          embeddedExecutable: metacharacterRuntime,
        }),
        { mode: 0o755 },
      );
      assert.equal(
        inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
        "foreign",
      );
    }

    const escapedRuntime = path.join(dir, "foo\\bar", "lefthook");
    fs.mkdirSync(path.dirname(escapedRuntime), { recursive: true });
    fs.writeFileSync(escapedRuntime, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      lefthookRunner("pre-commit", {
        embeddedExecutable: "foo\\bar/lefthook",
      }),
      { mode: 0o755 },
    );
    assert.equal(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
      "foreign",
    );
  }

  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    lefthookRunner("pre-commit"),
    { mode: 0o755 },
  );

  process.env.LEFTHOOK_BIN = "node_modules/.bin/false";
  assert.deepEqual(
    inspectHookManagerRunner("lefthook", ["pre-commit"], dir).hooks,
    [{ name: "pre-commit", status: "missing-runtime" }],
  );
  process.env.LEFTHOOK_BIN = path.join(outside, lefthookExecutable);
  assert.equal(
    inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
    "wired",
  );
  delete process.env.LEFTHOOK_BIN;

  if (process.platform !== "win32") {
    const literalBackslashLefthook = path.join(dir, "prefix\\lefthook");
    fs.writeFileSync(literalBackslashLefthook, "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    process.env.LEFTHOOK_BIN = "prefix\\lefthook";
    assert.deepEqual(
      inspectHookManagerRunner("lefthook", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "missing-runtime" }],
    );
    delete process.env.LEFTHOOK_BIN;
    fs.rmSync(literalBackslashLefthook);
  }

  writeCrossPlatformShim(binDir, "lefthook.exe", "process.exit(0);\n");
  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    lefthookRunner("pre-commit", {
      embeddedExecutable: "node_modules/.bin/lefthook.exe",
    }),
    { mode: 0o755 },
  );
  assert.equal(
    inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
    process.platform === "win32" ? "wired" : "foreign",
  );

  fs.mkdirSync(path.join(dir, "node_modules", "lefthook", "bin"), {
    recursive: true,
  });
  writeCrossPlatformShim(
    path.join(dir, "node_modules", "lefthook", "bin"),
    "index.js",
    "process.exit(0);\n",
  );
  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    lefthookRunner("pre-commit", {
      embeddedExecutable: "node_modules/lefthook/bin/index.js",
    }),
    { mode: 0o755 },
  );
  assert.equal(
    inspectHookManagerRunner("lefthook", ["pre-commit"], dir).status,
    "foreign",
  );
  fs.rmSync(path.join(dir, "node_modules", "lefthook"), {
    recursive: true,
  });

  for (const [name, content] of [
    ["pre-push", '#!/bin/false\nlefthook run "pre-push" "$@"\n'],
    ["pre-push", '#!/bin/sh -n\nlefthook run "pre-push" "$@"\n'],
    ["pre-push", '#!/bin/sh\ncall_lefthook run "pre-push" "$@"\n'],
    ["pre-push", '#!/bin/sh\nlefthook run "pre-push" "$@" || true\n'],
    ["pre-push", '#!/bin/sh\nexit 0\nlefthook run "pre-push" "$@"\n'],
    ["commit-msg", '#!/bin/sh\nlefthook run "commit-msg"\n'],
  ]) {
    fs.writeFileSync(path.join(hooksDir, name), content, { mode: 0o755 });
    assert.equal(
      inspectHookManagerRunner("lefthook", [name], dir).status,
      "foreign",
      content,
    );
  }

  fs.writeFileSync(
    path.join(hooksDir, "commit-msg"),
    '#!/bin/sh\nexec node_modules/.bin/lefthook run "commit-msg" "$@"\n',
    { mode: 0o755 },
  );
  assert.equal(
    inspectHookManagerRunner("lefthook", ["commit-msg"], dir).status,
    "wired",
  );

  for (const name of names) {
    fs.writeFileSync(
      path.join(hooksDir, name),
      preCommitRunner(name, {
        installPython: "node_modules/.bin/python3",
      }),
      { mode: 0o755 },
    );
  }
  assert.equal(
    inspectHookManagerRunner("pre-commit", names, dir).status,
    "wired",
  );
  if (process.platform !== "win32") {
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      preCommitRunner("pre-commit", {
        installPython: "node_modules/.bin/python3",
        windowsLauncher: true,
      }),
      { mode: 0o755 },
    );
    assert.deepEqual(
      inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "foreign" }],
    );
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      preCommitRunner("pre-commit", {
        installPython: "node_modules/.bin/python3",
      }).replaceAll("\n", "\r\n"),
      { mode: 0o755 },
    );
    assert.deepEqual(
      inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "foreign" }],
    );
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      preCommitRunner("pre-commit", {
        installPython: "node_modules/.bin/python3",
      }),
      { mode: 0o755 },
    );
  }

  writeCrossPlatformShim(binDir, "python3.13t", "process.exit(0);\n");
  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    preCommitRunner("pre-commit", {
      installPython: "node_modules/.bin/python3.13t",
    }),
    { mode: 0o755 },
  );
  assert.equal(
    inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).status,
    "wired",
  );
  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    preCommitRunner("pre-commit", {
      installPython: "node_modules/.bin/python3",
    }),
    { mode: 0o755 },
  );

  if (process.platform !== "win32") {
    fs.rmSync(path.join(binDir, "python3"));
    fs.symlinkSync(process.execPath, path.join(binDir, "python3"));
    assert.deepEqual(
      inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "missing-runtime" }],
    );
    fs.rmSync(path.join(binDir, "python3"));
    writeCrossPlatformShim(binDir, "python3", "process.exit(0);\n");
  }

  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    preCommitRunner("pre-commit", {
      installPython: "'node_modules/.bin/python3'",
      skipOnMissingConfig: true,
      windowsLauncher: true,
    }).replaceAll("\n", "\r\n"),
    { mode: 0o755 },
  );
  assert.equal(
    inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).status,
    process.platform === "win32" ? "wired" : "foreign",
  );

  for (const content of [
    preCommitRunner("commit-msg").replace(
      'HERE="$(cd "$(dirname "$0")" && pwd)"\n',
      "",
    ),
    preCommitRunner("commit-msg").replace(
      'ARGS+=(--hook-dir "$HERE" -- "$@")\n',
      "",
    ),
    preCommitRunner("commit-msg").replace(
      "--config=.pre-commit-config.yaml",
      "--config=missing.yaml",
    ),
    preCommitRunner("commit-msg").replace(
      "# end templated",
      "exit 0\n# end templated",
    ),
    "#!/usr/bin/env python3\n# File generated by pre-commit: https://pre-commit.com\nraise SystemExit(0)\n",
  ]) {
    fs.writeFileSync(path.join(hooksDir, "commit-msg"), content, {
      mode: 0o755,
    });
    assert.equal(
      inspectHookManagerRunner("pre-commit", ["commit-msg"], dir).status,
      "foreign",
      content,
    );
  }

  fs.writeFileSync(path.join(dir, ".pre-commit-config.yml"), "repos: []\n");
  fs.writeFileSync(
    path.join(hooksDir, "commit-msg"),
    preCommitRunner("commit-msg", {
      config: ".pre-commit-config.yml",
      installPython: "node_modules/.bin/python3",
    }),
    { mode: 0o755 },
  );
  assert.equal(
    inspectHookManagerRunner("pre-commit", ["commit-msg"], dir).status,
    "wired",
  );

  fs.writeFileSync(path.join(dir, ".pre-commit-config.yaml"), "repos: []\n");
  assert.deepEqual(
    inspectHookManagerRunner("pre-commit", ["commit-msg"], dir),
    {
      manager: "pre-commit",
      destination: "Git's effective hooks directory",
      status: "uninspectable",
      hooks: [{ name: "commit-msg", status: "uninspectable" }],
    },
  );
  fs.rmSync(path.join(dir, ".pre-commit-config.yaml"));

  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    preCommitRunner("pre-commit", {
      config: ".pre-commit-config.yml",
      installPython: "missing/pre-commit-python",
    }),
    { mode: 0o755 },
  );
  assert.deepEqual(
    inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).hooks,
    [{ name: "pre-commit", status: "missing-runtime" }],
  );
  writeCrossPlatformShim(binDir, "true", "process.exit(0);\n");
  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    preCommitRunner("pre-commit", {
      config: ".pre-commit-config.yml",
      installPython: "node_modules/.bin/true",
    }),
    { mode: 0o755 },
  );
  assert.deepEqual(
    inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).hooks,
    [{ name: "pre-commit", status: "missing-runtime" }],
  );
  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    preCommitRunner("pre-commit", {
      config: ".pre-commit-config.yml",
      installPython: "missing/pre-commit-python",
    }),
    { mode: 0o755 },
  );
  writeCrossPlatformShim(isolatedPath, "pre-commit", "process.exit(0);\n");
  assert.equal(
    inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).status,
    "wired",
  );
  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    preCommitRunner("pre-commit", {
      config: ".pre-commit-config.yml",
      installPython: "''",
    }),
    { mode: 0o755 },
  );
  assert.equal(
    inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).status,
    "wired",
  );
  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    preCommitRunner("pre-commit", {
      config: ".pre-commit-config.yml",
      installPython: "missing/pre-commit-python",
    }),
    { mode: 0o755 },
  );
  if (process.platform !== "win32") {
    fs.rmSync(path.join(isolatedPath, "pre-commit"));
    fs.symlinkSync(process.execPath, path.join(isolatedPath, "pre-commit"));
    assert.deepEqual(
      inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "missing-runtime" }],
    );
    fs.rmSync(path.join(isolatedPath, "pre-commit"));
    writeCrossPlatformShim(isolatedPath, "pre-commit", "process.exit(0);\n");

    fs.chmodSync(path.join(isolatedPath, "pre-commit"), 0o644);
    writeCrossPlatformShim(fallbackPath, "pre-commit", "process.exit(0);\n");
    process.env.PATH = `${isolatedPath}${path.delimiter}${fallbackPath}`;
    assert.equal(
      inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).status,
      "wired",
    );

    fs.rmSync(path.join(isolatedPath, "pre-commit"));
    const fifo = path.join(isolatedPath, "pre-commit");
    assert.equal(
      run("mkfifo", [fifo], dir, {
        env: { ...process.env, PATH: originalPath },
      }).status,
      0,
    );
    fs.chmodSync(fifo, 0o644);
    assert.equal(
      inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).status,
      "wired",
    );
    fs.chmodSync(fifo, 0o755);
    assert.deepEqual(
      inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "missing-runtime" }],
    );

    fs.rmSync(fifo);
    const nonDirectoryPathRoot = path.join(dir, "path-component-file");
    fs.writeFileSync(nonDirectoryPathRoot, "not a directory\n");
    process.env.PATH = `${nonDirectoryPathRoot}${path.delimiter}${fallbackPath}${path.delimiter}${isolatedPath}`;
    assert.equal(
      inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).status,
      "wired",
    );
    const loopPath = path.join(dir, ".runner-loop");
    fs.mkdirSync(loopPath);
    fs.symlinkSync("pre-commit", path.join(loopPath, "pre-commit"));
    process.env.PATH = `${loopPath}${path.delimiter}${fallbackPath}${path.delimiter}${isolatedPath}`;
    assert.equal(
      inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).status,
      "wired",
    );

    process.env.PATH = `"${fallbackPath}"${path.delimiter}${isolatedPath}`;
    assert.deepEqual(
      inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "missing-runtime" }],
    );

    writeCrossPlatformShim(dir, "pre-commit", "process.exit(0);\n");
    process.env.PATH = `${path.delimiter}${isolatedPath}`;
    assert.equal(
      inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).status,
      "wired",
    );
    fs.rmSync(path.join(dir, "pre-commit"));
    fs.rmSync(path.join(dir, "pre-commit.cmd"));
    fs.rmSync(path.join(dir, "pre-commit-shim.mjs"));
    writeCrossPlatformShim(isolatedPath, "pre-commit", "process.exit(0);\n");
    process.env.PATH = isolatedPath;

    fs.rmSync(path.join(binDir, "python3"));
    fs.symlinkSync("python3", path.join(binDir, "python3"));
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      preCommitRunner("pre-commit", {
        config: ".pre-commit-config.yml",
        installPython: "node_modules/.bin/python3",
      }),
      { mode: 0o755 },
    );
    assert.equal(
      inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).status,
      "wired",
    );
    fs.rmSync(path.join(binDir, "python3"));
    fs.mkdirSync(path.join(binDir, "python3"));
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      preCommitRunner("pre-commit", {
        config: ".pre-commit-config.yml",
        installPython: "node_modules/.bin/python3",
      }),
      { mode: 0o755 },
    );
    assert.deepEqual(
      inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "missing-runtime" }],
    );
    fs.rmSync(path.join(binDir, "python3"), { recursive: true });
    writeCrossPlatformShim(binDir, "python3", "process.exit(0);\n");

    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      preCommitRunner("pre-commit", {
        config: ".pre-commit-config.yml",
        installPython: "python3",
      }),
      { mode: 0o755 },
    );
    assert.equal(
      inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).status,
      "wired",
    );
    fs.writeFileSync(path.join(dir, "python3"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    assert.deepEqual(
      inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "missing-runtime" }],
    );
    fs.rmSync(path.join(dir, "python3"));

    const literalBackslashPython = path.join(dir, "prefix\\python3");
    fs.writeFileSync(literalBackslashPython, "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      preCommitRunner("pre-commit", {
        config: ".pre-commit-config.yml",
        installPython: "'prefix\\python3'",
      }),
      { mode: 0o755 },
    );
    assert.deepEqual(
      inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "missing-runtime" }],
    );
    fs.rmSync(literalBackslashPython);
  }
  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    preCommitRunner("pre-commit", {
      config: ".pre-commit-config.yml",
      installPython: "node_modules/.bin/true",
    }),
    { mode: 0o755 },
  );
  assert.deepEqual(
    inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).hooks,
    [{ name: "pre-commit", status: "missing-runtime" }],
  );

  if (process.platform !== "win32") {
    fs.chmodSync(path.join(hooksDir, "commit-msg"), 0o644);
    assert.deepEqual(
      inspectHookManagerRunner("pre-commit", ["commit-msg"], dir).hooks.filter(
        ({ status }) => status !== "wired",
      ),
      [{ name: "commit-msg", status: "non-executable" }],
    );
    fs.rmSync(path.join(hooksDir, "commit-msg"));
    fs.writeFileSync(path.join(outside, "commit-msg"), "outside\n");
    fs.symlinkSync(
      path.join(outside, "commit-msg"),
      path.join(hooksDir, "commit-msg"),
    );
    assert.equal(
      inspectHookManagerRunner("pre-commit", names, dir).status,
      "uninspectable",
    );

    fs.rmSync(hooksDir, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(
      path.join(outside, "pre-commit"),
      preCommitRunner("pre-commit", { config: ".pre-commit-config.yml" }),
      { mode: 0o755 },
    );
    fs.symlinkSync(outside, hooksDir);
    assert.equal(
      inspectHookManagerRunner("pre-commit", ["pre-commit"], dir).status,
      "uninspectable",
    );
  }

  assert.equal(
    inspectHookManagerRunner("lefthook", ["pre-commit"], outside).status,
    "uninspectable",
  );
  assert.throws(
    () => inspectHookManagerRunner("unknown", names, dir),
    /Unsupported hook-manager runner/u,
  );
});

test("Husky runner inspection verifies every effective wrapper fail-closed", (t) => {
  const dir = createTempRepo();
  t.after(() => cleanupTempRepo(dir));
  run("git", ["config", "core.hooksPath", ".husky/_"], dir);
  const hooksDir = path.join(dir, ".husky", "_");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, "h"), HUSKY_V9_RUNTIME);

  assert.deepEqual(
    inspectHookManagerRunner("husky", ["pre-commit"], dir).hooks,
    [{ name: "pre-commit", status: "missing" }],
  );
  fs.writeFileSync(path.join(hooksDir, "h"), "# foreign runtime\n");
  assert.deepEqual(
    inspectHookManagerRunner("husky", ["pre-commit"], dir).hooks,
    [{ name: "pre-commit", status: "foreign-runtime" }],
  );
  fs.writeFileSync(path.join(hooksDir, "h"), HUSKY_V9_RUNTIME);

  const wrapper = path.join(hooksDir, "pre-commit");
  fs.writeFileSync(wrapper, '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n', {
    mode: 0o755,
  });
  assert.equal(
    inspectHookManagerRunner("husky", ["pre-commit"], dir).status,
    "wired",
  );
  if (process.platform !== "win32") {
    fs.writeFileSync(
      path.join(hooksDir, "h"),
      HUSKY_V9_RUNTIME.replaceAll("\n", "\r\n"),
    );
    assert.deepEqual(
      inspectHookManagerRunner("husky", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "foreign-runtime" }],
    );
    fs.writeFileSync(path.join(hooksDir, "h"), HUSKY_V9_RUNTIME);
    fs.writeFileSync(
      wrapper,
      '#!/usr/bin/env sh\r\n. "$(dirname "$0")/h"\r\n',
      { mode: 0o755 },
    );
    assert.deepEqual(
      inspectHookManagerRunner("husky", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "foreign" }],
    );
    fs.writeFileSync(wrapper, '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n', {
      mode: 0o755,
    });
  }

  for (const runtime of HUSKY_V9_RUNTIME_VARIANTS) {
    fs.writeFileSync(path.join(hooksDir, "h"), runtime);
    for (const source of ['. "${0%/*}/h"', '. "$(dirname "$0")/h"']) {
      fs.writeFileSync(wrapper, `#!/usr/bin/env sh\n${source}\n`, {
        mode: 0o755,
      });
      assert.equal(
        inspectHookManagerRunner("husky", ["pre-commit"], dir).status,
        "wired",
        source,
      );
    }
  }
  fs.writeFileSync(
    path.join(hooksDir, "h"),
    HUSKY_V9_RUNTIME_VARIANTS[0].replace(/exit \$c\n?$/u, "exit 1"),
  );
  assert.deepEqual(
    inspectHookManagerRunner("husky", ["pre-commit"], dir).hooks,
    [{ name: "pre-commit", status: "foreign-runtime" }],
  );
  fs.writeFileSync(path.join(hooksDir, "h"), HUSKY_V9_RUNTIME);
  fs.writeFileSync(wrapper, '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n', {
    mode: 0o755,
  });

  fs.writeFileSync(
    path.join(hooksDir, "h"),
    [
      "#!/usr/bin/env sh",
      "if false; then",
      '  n=$(basename "$0")',
      '  s=$(dirname "$(dirname "$0")")/$n',
      '  [ ! -f "$s" ] && exit 0',
      '  sh -e "$s" "$@"',
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    inspectHookManagerRunner("husky", ["pre-commit"], dir).hooks,
    [{ name: "pre-commit", status: "foreign-runtime" }],
  );
  fs.writeFileSync(path.join(hooksDir, "h"), HUSKY_V9_RUNTIME);

  fs.writeFileSync(wrapper, '#!/usr/bin/env sh\n. "$(dirname -- "$0")/h"\n', {
    mode: 0o755,
  });
  assert.equal(
    inspectHookManagerRunner("husky", ["pre-commit"], dir).status,
    "wired",
  );

  fs.writeFileSync(wrapper, "#!/bin/sh\necho foreign\n", { mode: 0o755 });
  assert.deepEqual(
    inspectHookManagerRunner("husky", ["pre-commit"], dir).hooks,
    [{ name: "pre-commit", status: "foreign" }],
  );

  if (process.platform !== "win32") {
    fs.chmodSync(wrapper, 0o644);
    assert.deepEqual(
      inspectHookManagerRunner("husky", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "foreign" }],
    );
    fs.writeFileSync(wrapper, '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n', {
      mode: 0o644,
    });
    assert.deepEqual(
      inspectHookManagerRunner("husky", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "non-executable" }],
    );
    fs.chmodSync(wrapper, 0o755);
  }

  // Keep the wrapper valid before isolating shared-runtime failures. The
  // POSIX-only mode checks above rewrite it, while Windows skips those checks.
  fs.writeFileSync(wrapper, '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n', {
    mode: 0o755,
  });

  fs.writeFileSync(path.join(hooksDir, "h"), "# foreign runtime\n");
  assert.deepEqual(
    inspectHookManagerRunner("husky", ["pre-commit"], dir).hooks,
    [{ name: "pre-commit", status: "foreign-runtime" }],
  );

  fs.rmSync(path.join(hooksDir, "h"));
  assert.deepEqual(
    inspectHookManagerRunner("husky", ["pre-commit"], dir).hooks,
    [{ name: "pre-commit", status: "missing-runtime" }],
  );
  if (process.platform !== "win32") {
    const outsideWrapper = path.join(dir, "outside-husky-wrapper");
    fs.writeFileSync(
      outsideWrapper,
      '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n',
      { mode: 0o755 },
    );
    fs.rmSync(wrapper);
    fs.symlinkSync(outsideWrapper, wrapper);
    assert.deepEqual(
      inspectHookManagerRunner("husky", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "uninspectable" }],
    );
    fs.rmSync(wrapper);
    fs.rmSync(outsideWrapper);
    fs.writeFileSync(wrapper, '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n', {
      mode: 0o755,
    });
  }
  fs.mkdirSync(path.join(hooksDir, "h"));
  assert.equal(
    inspectHookManagerRunner("husky", ["pre-commit"], dir).status,
    "uninspectable",
  );
});

test("Husky v8 direct hook paths do not require the v9 runtime", (t) => {
  const dir = createTempRepo();
  t.after(() => cleanupTempRepo(dir));
  run("git", ["config", "core.hooksPath", `.husky${path.sep}`], dir);
  const hooksDir = path.join(dir, ".husky");
  fs.mkdirSync(hooksDir, { recursive: true });

  for (const name of ["pre-commit", "pre-push"]) {
    fs.writeFileSync(
      path.join(hooksDir, name),
      ["#!/usr/bin/env sh", hookInvocation(name), ""].join("\n"),
      { mode: 0o755 },
    );
  }

  const names = ["pre-commit", "pre-push"];
  assert.equal(inspectHookManager("husky", names, dir).status, "wired");
  assert.equal(inspectHookManagerRunner("husky", names, dir).status, "wired");
  assert.equal(fs.existsSync(path.join(hooksDir, "h")), false);

  const preCommitPath = path.join(hooksDir, "pre-commit");
  const preCommitBody = fs.readFileSync(preCommitPath, "utf8");
  fs.writeFileSync(
    preCommitPath,
    `#!/bin/false\n${hookInvocation("pre-commit")}\n`,
    { mode: 0o755 },
  );
  assert.equal(
    inspectHookManager("husky", ["pre-commit"], dir).status,
    "missing",
  );
  fs.writeFileSync(preCommitPath, preCommitBody, { mode: 0o755 });

  if (process.platform !== "win32") {
    fs.chmodSync(path.join(hooksDir, "pre-push"), 0o644);
    assert.deepEqual(
      inspectHookManagerRunner("husky", names, dir).hooks.filter(
        ({ status }) => status !== "wired",
      ),
      [{ name: "pre-push", status: "non-executable" }],
    );
  }
});

test("Husky runner inspection never trims a configured hooks path", (t) => {
  const dir = createTempRepo();
  t.after(() => cleanupTempRepo(dir));
  const huskyDir = path.join(dir, ".husky");
  fs.mkdirSync(huskyDir);
  fs.writeFileSync(
    path.join(huskyDir, "pre-commit"),
    "#!/bin/sh\nnode_modules/.bin/commitment-issues precommit || exit $?\n",
    { mode: 0o755 },
  );

  for (const configured of [" .husky", ".husky ", ".husky\n"]) {
    const set = run("git", ["config", "core.hooksPath", configured], dir);
    assert.equal(set.status, 0, `${set.stdout}${set.stderr}`);
    const report = inspectHookManagerRunner("husky", ["pre-commit"], dir);
    assert.notEqual(report.status, "wired");
    assert.equal(report.destination, path.resolve(dir, configured));
  }
});

test("Husky v8 direct hooks require a valid runtime only when sourced", (t) => {
  const dir = createTempRepo();
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), "husky-v8-runtime-target-"),
  );
  t.after(() => cleanupTempRepo(dir));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  run("git", ["config", "core.hooksPath", ".husky"], dir);
  const hooksDir = path.join(dir, ".husky");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    [
      "#!/usr/bin/env sh",
      '. "$(dirname -- "$0")/_/husky.sh"',
      hookInvocation("pre-commit"),
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  assert.equal(
    inspectHookManager("husky", ["pre-commit"], dir).status,
    "wired",
  );
  assert.deepEqual(
    inspectHookManagerRunner("husky", ["pre-commit"], dir).hooks,
    [{ name: "pre-commit", status: "missing-runtime" }],
  );

  fs.mkdirSync(path.join(hooksDir, "_"));
  fs.writeFileSync(path.join(hooksDir, "_", "husky.sh"), "# incomplete\n");
  assert.deepEqual(
    inspectHookManagerRunner("husky", ["pre-commit"], dir).hooks,
    [{ name: "pre-commit", status: "foreign-runtime" }],
  );

  fs.writeFileSync(path.join(hooksDir, "_", "husky.sh"), HUSKY_V8_RUNTIME);
  assert.equal(
    inspectHookManagerRunner("husky", ["pre-commit"], dir).status,
    "wired",
  );

  fs.writeFileSync(
    path.join(hooksDir, "_", "husky.sh"),
    HUSKY_V8_RUNTIME.replace(
      "if [ $exitCode = 127 ]; then",
      "if [ $exitCode == 127 ]; then",
    ),
  );
  assert.deepEqual(
    inspectHookManagerRunner("husky", ["pre-commit"], dir).hooks,
    [{ name: "pre-commit", status: "foreign-runtime" }],
  );
  fs.writeFileSync(path.join(hooksDir, "_", "husky.sh"), HUSKY_V8_RUNTIME);

  fs.rmSync(path.join(hooksDir, "_"), { recursive: true });
  fs.writeFileSync(path.join(outside, "husky.sh"), "outside runtime\n");
  fs.symlinkSync(outside, path.join(hooksDir, "_"), "dir");
  let outsideReads = 0;
  const originalRead = fs.readFileSync;
  fs.readFileSync = (...args) => {
    if (path.resolve(String(args[0])).startsWith(path.resolve(outside))) {
      outsideReads += 1;
    }
    return originalRead(...args);
  };
  try {
    assert.deepEqual(
      inspectHookManagerRunner("husky", ["pre-commit"], dir).hooks,
      [{ name: "pre-commit", status: "uninspectable" }],
    );
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(outsideReads, 0);
});
