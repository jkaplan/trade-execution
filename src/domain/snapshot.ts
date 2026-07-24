export type SnapshotFingerprint = {
  fingerprint: string;
  mtimeMs: number;
};

export function hasSnapshotChanged(
  previous: SnapshotFingerprint | null,
  next: SnapshotFingerprint
): boolean {
  if (previous === null) {
    return true;
  }

  return previous.fingerprint !== next.fingerprint || previous.mtimeMs !== next.mtimeMs;
}