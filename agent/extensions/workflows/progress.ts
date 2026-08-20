export const WORKFLOW_PROGRESS_INTERVAL_MS = 1_000;

/** Coalesces noisy token-level workflow events into stable tool-card updates. */
export function createWorkflowProgressPublisher(
  publish: () => void,
  intervalMs = WORKFLOW_PROGRESS_INTERVAL_MS,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastPublishedAt = 0;

  const publishNow = () => {
    timer = undefined;
    lastPublishedAt = Date.now();
    publish();
  };

  return {
    request() {
      if (timer) return;
      timer = setTimeout(
        publishNow,
        Math.max(0, intervalMs - (Date.now() - lastPublishedAt)),
      );
      timer.unref?.();
    },
    flush() {
      if (timer) clearTimeout(timer);
      publishNow();
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
