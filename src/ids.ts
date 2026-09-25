/** Checkpoints, restores, forks, gate waits, and message-edit operations. */
export type IdPrefix = "ck" | "rs" | "fk" | "gw" | "op";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * Time-ordered, ref-safe ids: `ck_` + 9 base36 time digits + 7 random digits.
 * They double as git ref names (`refs/rewind/<id>`), so the alphabet stays
 * lowercase alphanumeric. Uses Web Crypto so the module stays importable from
 * the app bundle as well as Node.
 */
export function newId(prefix: IdPrefix, now = Date.now()): string {
  const time = now.toString(36).padStart(9, "0").slice(-9);
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(7));
  let random = "";
  for (const byte of bytes) random += ALPHABET[byte % 36];
  return `${prefix}_${time}${random}`;
}

export const CHECKPOINT_ID_PATTERN = /^ck_[a-z0-9]{8,40}$/;
export const RESTORE_ID_PATTERN = /^rs_[a-z0-9]{8,40}$/;
export const FORK_ID_PATTERN = /^fk_[a-z0-9]{8,40}$/;
export const THREAD_ID_PATTERN = /^thr_[a-z0-9]{4,64}$/;
