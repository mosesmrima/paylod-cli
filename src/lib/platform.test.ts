/**
 * Platform behaviour — the cross-platform reality check.
 *
 * We can only EXECUTE on Linux here. So the Windows and macOS branches are exercised by
 * stubbing `process.platform` (via PAYLOD_FAKE_PLATFORM, the seam `platform()` reads) and by
 * unit-testing the pure pieces — the path resolution, the icacls ACL parser, the browser
 * command construction. That is verification by inspection plus stubbed tests; it is NOT the
 * same as running on the OS, and the report says so.
 *
 * What these tests DO prove is that the branches exist, are reachable, and compute what we
 * claim they compute — which is more than 0.1.0 could say, where the Windows branch was a
 * silent no-op that nothing would ever have caught.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  aclPrincipalsOtherThan,
  inspectPath,
  legacyConfigDir,
  platform,
  platformConfigDir,
  protectPath,
  resetWarnings,
  secureMkdir,
  secureWriteFile,
  warnIfUnprotected,
} from "./platform.js";
import { configDir } from "./config.js";
import { browserCommand } from "./oauth.js";
import { sandbox, type Sandbox } from "../test/helpers.js";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
  resetWarnings();
});
afterEach(() => box.cleanup());

describe("config directory: the conventional location on each platform", () => {
  // 0.1.0 put the config in ~/.config/paylod on EVERY platform. That technically works on
  // Windows and macOS but it is not where anyone looks, and it is not where the OS's own
  // per-user protections are strongest.
  test("Windows → %APPDATA%\\paylod", () => {
    box.env("PAYLOD_FAKE_PLATFORM", "win32");
    box.env("APPDATA", "C:\\Users\\moses\\AppData\\Roaming");
    assert.equal(platform(), "win32");
    assert.equal(platformConfigDir(), join("C:\\Users\\moses\\AppData\\Roaming", "paylod"));
  });

  test("Windows without APPDATA falls back to the standard Roaming path", () => {
    box.env("PAYLOD_FAKE_PLATFORM", "win32");
    box.env("APPDATA", undefined);
    box.env("PAYLOD_FAKE_HOME", "C:\\Users\\moses");
    assert.equal(
      platformConfigDir(),
      join("C:\\Users\\moses", "AppData", "Roaming", "paylod"),
    );
  });

  test("macOS → ~/Library/Application Support/paylod", () => {
    box.env("PAYLOD_FAKE_PLATFORM", "darwin");
    box.env("PAYLOD_FAKE_HOME", "/Users/moses");
    assert.equal(platformConfigDir(), "/Users/moses/Library/Application Support/paylod");
  });

  test("Linux → XDG, honouring XDG_CONFIG_HOME", () => {
    box.env("PAYLOD_FAKE_PLATFORM", "linux");
    box.env("PAYLOD_FAKE_HOME", "/home/moses");
    assert.equal(platformConfigDir(), "/home/moses/.config/paylod");

    box.env("XDG_CONFIG_HOME", "/home/moses/.myconfig");
    assert.equal(platformConfigDir(), "/home/moses/.myconfig/paylod");
  });
});

describe("existing users are not orphaned by the move", () => {
  test("PAYLOD_CONFIG_DIR always wins", () => {
    box.env("PAYLOD_CONFIG_DIR", "/tmp/explicit");
    box.env("PAYLOD_FAKE_PLATFORM", "darwin");
    assert.equal(configDir(), "/tmp/explicit");
  });

  test("a macOS user with an existing 0.1.0 config keeps using ~/.config/paylod", () => {
    // The whole point: upgrading must not silently log people out and strand a credential
    // file at the old path.
    const home = box.dir;
    const legacy = join(home, ".config", "paylod");
    secureMkdir(legacy);
    writeFileSync(join(legacy, "config.json"), "{}");

    box.env("PAYLOD_CONFIG_DIR", undefined);
    box.env("PAYLOD_FAKE_PLATFORM", "darwin");
    box.env("PAYLOD_FAKE_HOME", home);

    assert.equal(legacyConfigDir(), legacy);
    assert.equal(configDir(), legacy, "an existing legacy config must keep being used");
  });

  test("a NEW macOS user gets the conventional Application Support path", () => {
    box.env("PAYLOD_CONFIG_DIR", undefined);
    box.env("PAYLOD_FAKE_PLATFORM", "darwin");
    box.env("PAYLOD_FAKE_HOME", box.dir); // nothing in ~/.config/paylod

    assert.equal(configDir(), join(box.dir, "Library", "Application Support", "paylod"));
  });

  test("on Linux the legacy path IS the modern path — nothing changes", () => {
    box.env("PAYLOD_CONFIG_DIR", undefined);
    box.env("PAYLOD_FAKE_PLATFORM", "linux");
    box.env("PAYLOD_FAKE_HOME", box.dir);
    assert.equal(configDir(), join(box.dir, ".config", "paylod"));
    assert.equal(legacyConfigDir(), platformConfigDir());
  });
});

describe("POSIX protection (verified by execution on Linux)", () => {
  test("secureWriteFile creates the file 0600 and confirms it", () => {
    const f = join(box.dir, "secret.json");
    const p = secureWriteFile(f, "{}");

    assert.equal(p.protected, true);
    assert.equal(p.mechanism, "posix-mode");
    assert.equal(statSync(f).mode & 0o777, 0o600);
  });

  test("secureMkdir creates the directory 0700", () => {
    const d = join(box.dir, "sub");
    const p = secureMkdir(d);
    assert.equal(p.protected, true);
    assert.equal(statSync(d).mode & 0o077, 0);
  });

  test("protectPath TIGHTENS an already-loose file", () => {
    const f = join(box.dir, "loose.json");
    writeFileSync(f, "{}");
    chmodSync(f, 0o666);

    const p = protectPath(f, false);
    assert.equal(p.protected, true);
    assert.equal(statSync(f).mode & 0o077, 0);
  });

  test("inspectPath REPORTS without changing anything", () => {
    // whoami must not have the side effect of fixing what it reports on, or you can never
    // see that it was broken.
    const f = join(box.dir, "loose.json");
    writeFileSync(f, "{}");
    chmodSync(f, 0o644);

    const p = inspectPath(f);
    assert.equal(p.protected, false);
    assert.match(p.detail, /group\/other/i);
    assert.equal(statSync(f).mode & 0o777, 0o644, "inspectPath must not modify the file");
  });

  test("a missing file is reported as unprotected, not crashed on", () => {
    const p = inspectPath(join(box.dir, "does-not-exist.json"));
    assert.equal(p.protected, false);
  });
});

describe("an unknown platform is admitted, not assumed safe", () => {
  test("protectPath returns protected:false with an honest reason", () => {
    box.env("PAYLOD_FAKE_PLATFORM", "haiku"); // a real Node platform string we do not handle
    const f = join(box.dir, "x.json");
    writeFileSync(f, "{}");

    const p = protectPath(f, false);
    assert.equal(p.protected, false, "an unknown platform must never claim to be protected");
    assert.match(p.detail, /unknown platform/i);
  });
});

describe("the user is TOLD when we cannot protect the file", () => {
  const captured: string[] = [];
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    captured.length = 0;
    originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });
  afterEach(() => {
    process.stderr.write = originalWrite;
  });

  test("an unprotected file produces a loud stderr warning", () => {
    // This is the entire fix. Silently claiming a protection you do not provide is worse than
    // providing none, and that is what 0.1.0 did on Windows.
    warnIfUnprotected("C:\\Users\\moses\\AppData\\Roaming\\paylod\\config.json", {
      protected: false,
      mechanism: "none",
      detail: "chmod is a no-op on this platform",
    });

    const out = captured.join("");
    assert.match(out, /SECURITY/);
    assert.match(out, /could not restrict access/i);
    assert.match(out, /config\.json/);
    assert.match(out, /real money/i, "the warning must say what is at stake");
    assert.match(out, /icacls/i, "the warning must tell the user how to fix it");
  });

  test("a protected file produces NO warning", () => {
    warnIfUnprotected("/home/moses/.config/paylod/config.json", {
      protected: true,
      mechanism: "posix-mode",
      detail: "mode 600",
    });
    assert.equal(captured.join(""), "", "a protected file must not warn");
  });

  test("the warning fires once per path, not once per save", () => {
    const p = { protected: false as const, mechanism: "none" as const, detail: "nope" };
    warnIfUnprotected("/x/config.json", p);
    warnIfUnprotected("/x/config.json", p);
    warnIfUnprotected("/x/config.json", p);
    assert.equal(captured.length, 1, "a loop of saves must not spam the terminal");
  });

  test("PAYLOD_SUPPRESS_PERMISSION_WARNING=1 silences it — the user's call, not ours", () => {
    box.env("PAYLOD_SUPPRESS_PERMISSION_WARNING", "1");
    warnIfUnprotected("/x/config.json", { protected: false, mechanism: "none", detail: "nope" });
    assert.equal(captured.join(""), "");
  });
});

describe("the Windows ACL parser (verified by inspection + stubbed input)", () => {
  // icacls cannot run on Linux, so we test the thing that decides whether its output means
  // "safe": the parser. Real icacls output, captured from a Windows box's format.
  const ME = "DESKTOP-ABC\\moses";
  const FILE = "C:\\Users\\moses\\AppData\\Roaming\\paylod\\config.json";
  const SHORT = "C:\\x\\config.json";

  test("an ACL with only us (plus SYSTEM/Administrators) is clean", () => {
    const acl = [
      "C:\\Users\\moses\\AppData\\Roaming\\paylod\\config.json NT AUTHORITY\\SYSTEM:(F)",
      "                                                        BUILTIN\\Administrators:(F)",
      "                                                        DESKTOP-ABC\\moses:(F)",
      "",
      "Successfully processed 1 files; Failed processing 0 files",
    ].join("\r\n");

    assert.deepEqual(aclPrincipalsOtherThan(acl, ME, FILE), []);
  });

  test("BUILTIN\\Users on the ACL is flagged — this is the actual hole", () => {
    // This is what an inherited ACL under %APPDATA% looks like, and it is exactly what
    // 0.1.0's chmod-that-does-nothing left in place.
    const acl = [
      "C:\\Users\\moses\\AppData\\Roaming\\paylod\\config.json NT AUTHORITY\\SYSTEM:(F)",
      "                                                        BUILTIN\\Users:(RX)",
      "                                                        DESKTOP-ABC\\moses:(F)",
      "Successfully processed 1 files; Failed processing 0 files",
    ].join("\r\n");

    const others = aclPrincipalsOtherThan(acl, ME, FILE);
    assert.deepEqual(others, ["BUILTIN\\Users"]);
  });

  test("another human user on the ACL is flagged", () => {
    const acl = [
      "C:\\x\\config.json DESKTOP-ABC\\moses:(F)",
      "                  DESKTOP-ABC\\alice:(R)",
      "Successfully processed 1 files",
    ].join("\r\n");
    assert.deepEqual(aclPrincipalsOtherThan(acl, ME, SHORT), ["DESKTOP-ABC\\alice"]);
  });

  test("Everyone on the ACL is flagged", () => {
    const acl = "C:\\x\\config.json Everyone:(F)\r\nSuccessfully processed 1 files";
    assert.deepEqual(aclPrincipalsOtherThan(acl, ME, SHORT), ["Everyone"]);
  });

  test("the principal match is case-insensitive, as Windows account names are", () => {
    const acl = "C:\\x\\config.json desktop-abc\\MOSES:(F)\r\nSuccessfully processed 1 files";
    assert.deepEqual(aclPrincipalsOtherThan(acl, ME, SHORT), []);
  });

  test("inherited-flag suffixes like (OI)(CI)(F) are parsed, not mistaken for a principal", () => {
    const acl = [
      "C:\\x\\paylod BUILTIN\\Users:(OI)(CI)(RX)",
      "             DESKTOP-ABC\\moses:(OI)(CI)(F)",
      "Successfully processed 1 files",
    ].join("\r\n");
    assert.deepEqual(aclPrincipalsOtherThan(acl, ME, "C:\\x\\paylod"), ["BUILTIN\\Users"]);
  });
});

describe("opening a browser on each platform (verified by inspection + stubbed platform)", () => {
  // A real authorize URL. Note the `&` separators — they are the bug.
  const URL =
    "https://paylod.dev/oauth/authorize?response_type=code&client_id=c1&state=s1&scope=paylod:apps.write";

  test("Linux → xdg-open, URL passed as a single argv entry", () => {
    const { cmd, args } = browserCommand(URL, "linux");
    assert.equal(cmd, "xdg-open");
    assert.deepEqual(args, [URL]);
  });

  test("macOS → open, URL passed as a single argv entry", () => {
    const { cmd, args } = browserCommand(URL, "darwin");
    assert.equal(cmd, "open");
    assert.deepEqual(args, [URL]);
  });

  test("Windows → cmd start, with `&` ESCAPED", () => {
    // 0.1.0 ran `spawn("cmd", ["/c","start","",url])`. cmd.exe re-parses its command line and
    // `&` is its command separator, so the URL was truncated at the first `&` — login could
    // never have completed on Windows — and the remainder was handed to cmd AS COMMANDS.
    const { cmd, args, windowsVerbatimArguments } = browserCommand(URL, "win32");

    assert.equal(cmd, "cmd");
    assert.equal(windowsVerbatimArguments, true, "Node must not re-quote around our escaping");

    const urlArg = args[args.length - 1]!;
    assert.ok(urlArg.startsWith('"') && urlArg.endsWith('"'), "the URL must be quoted");
    assert.ok(!/[^^]&/.test(urlArg), `every & must be escaped as ^&, got: ${urlArg}`);
    assert.ok(urlArg.includes("^&client_id=c1"), "the query string must survive intact");
    assert.ok(urlArg.includes("^&scope=paylod:apps.write"), "the last param must survive");
  });

  test("Windows: a URL with no & is still quoted and intact", () => {
    const { args } = browserCommand("https://paylod.dev/oauth/authorize", "win32");
    assert.equal(args[args.length - 1], '"https://paylod.dev/oauth/authorize"');
  });
});
