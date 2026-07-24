export function isProcessedSignal(processedSignalIds: ReadonlySet<string>, signalId: string): boolean {
  return processedSignalIds.has(signalId);
}