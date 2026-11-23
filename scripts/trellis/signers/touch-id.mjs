// Trellis frame — changes here require human ratification and will fail the Trellis check.
//
// Signs with a key in the Mac's Secure Enclave, which signs only after Touch ID.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const KEY = process.env.TRELLIS_KEY ?? join(homedir(), ".trellis", "id_ecdsa_sk_rk_trellis-ratify");

export function sign(statement, namespace) {
  const dir = mkdtempSync(join(tmpdir(), "trellis-sign-"));
  try {
    const file = join(dir, "statement");
    writeFileSync(file, statement);
    execFileSync("ssh-keygen", ["-Y", "sign", "-f", KEY, "-n", namespace, file], {
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, SSH_SK_PROVIDER: "/usr/lib/ssh-keychain.dylib" },
    });
    return readFileSync(`${file}.sig`, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
