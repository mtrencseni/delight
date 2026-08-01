// sftp:// paths, frontend side. The backend speaks SFTP over the system ssh
// binary (src-tauri/src/sftp.rs); this half just recognizes the scheme and
// keeps the canonical form tidy.
//
// `ssh://` is accepted as an alias for `sftp://` — SFTP always runs inside an
// SSH connection, so they name the same thing — and is rewritten to sftp:// so
// there's one form in favorites, tabs and the path bar.

const SCHEMES = ["sftp://", "ssh://"];

export function isSftpPath(p: string): boolean {
  return SCHEMES.some((s) => p.slice(0, s.length).toLowerCase() === s);
}

/** True for any path the backend handles remotely (used to gate polling,
    drag-out, and the OS-only actions that need a real file on disk). */
export function isRemotePath(p: string): boolean {
  return isSftpPath(p);
}

/** Rewrite an `ssh://` URL to the canonical `sftp://`, and drop a password if
    one was typed: OpenSSH takes no password on the command line, so carrying it
    would only put it in the path bar and in settings.json for nothing. */
export function canonicalSftp(p: string): string {
  const scheme = SCHEMES.find((s) => p.slice(0, s.length).toLowerCase() === s);
  if (!scheme) return p;
  const body = p.slice(scheme.length);
  const slash = body.indexOf("/");
  let authority = slash < 0 ? body : body.slice(0, slash);
  const rest = slash < 0 ? "" : body.slice(slash);
  const at = authority.lastIndexOf("@");
  if (at >= 0) {
    const cred = authority.slice(0, at);
    const colon = cred.indexOf(":");
    if (colon >= 0) authority = `${cred.slice(0, colon)}@${authority.slice(at + 1)}`;
  }
  return `sftp://${authority}${rest}`;
}
