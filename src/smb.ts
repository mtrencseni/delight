// smb:// paths, frontend side. Delight speaks one portable form everywhere —
// smb://[user@]host/share/… with forward slashes — and the backend translates
// to whatever the OS needs (UNC on Windows). This module is the frontend's
// half: recognizing the scheme, and parsing a typed URL so an inline password
// is used exactly once for sign-in and never stored, shown, or persisted.

export function isSmbPath(p: string): boolean {
  return /^smb:\/\//i.test(p);
}

/** Backend sentinel meaning "this server wants credentials". Keep in sync with
    AUTH_NEEDED in src-tauri/src/smb.rs. */
export const SMB_AUTH_NEEDED = "__smb_auth_required";

export function smbAuthNeeded(err: unknown): boolean {
  return String(err).includes(SMB_AUTH_NEEDED);
}

export interface SmbUrl {
  /** Password-less form — the only one that may be displayed or persisted. */
  canonical: string;
  host: string;
  user?: string;
  /** Present only when typed inline (smb://user:pass@host); use once, drop. */
  password?: string;
}

export function smbParse(p: string): SmbUrl | null {
  if (!isSmbPath(p)) return null;
  const body = p.slice(6);
  const slash = body.indexOf("/");
  const authority = slash < 0 ? body : body.slice(0, slash);
  const rest = (slash < 0 ? "" : body.slice(slash + 1)).replace(/^\/+/, "").replace(/\/+$/, "");
  // The LAST @ splits credentials from host — "user@domain" logins exist.
  const at = authority.lastIndexOf("@");
  const host = at < 0 ? authority : authority.slice(at + 1);
  if (!host) return null;
  let user: string | undefined;
  let password: string | undefined;
  if (at >= 0) {
    const cred = authority.slice(0, at);
    const colon = cred.indexOf(":");
    user = (colon < 0 ? cred : cred.slice(0, colon)) || undefined;
    if (colon >= 0) password = cred.slice(colon + 1);
  }
  const auth = user ? `${user}@${host}` : host;
  return {
    canonical: rest ? `smb://${auth}/${rest}` : `smb://${auth}`,
    host,
    user,
    password,
  };
}
