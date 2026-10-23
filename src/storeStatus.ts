import { useSyncExternalStore } from 'react';

let failure = '';
let retry: (() => void) | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function reportSaveFailed(message: string, again: () => void) {
  failure = message;
  retry = again;
  notify();
}

export function reportSaved() {
  if (!failure) return;
  failure = '';
  notify();
}

export function useStoreFailure(): { failure: string; retry: () => void } {
  const message = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => failure,
  );
  return { failure: message, retry: () => retry?.() };
}
