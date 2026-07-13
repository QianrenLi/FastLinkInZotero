export interface DebouncedFunction<T extends (...args: any[]) => any> {
  (...args: Parameters<T>): void;
  /** Run the pending call immediately, if one is scheduled. */
  flush(): void;
  /** Drop the pending call without running it. */
  cancel(): void;
}

export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number,
): DebouncedFunction<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;
  let lastThis: any = null;

  const invoke = (): void => {
    timeout = null;
    const args = lastArgs;
    const thisArg = lastThis;
    lastArgs = null;
    lastThis = null;
    if (args) func.apply(thisArg, args);
  };

  const debounced = function (this: any, ...args: Parameters<T>): void {
    lastArgs = args;
    // Preserve the caller's `this` so the deferred/flushed call runs in
    // context. Aliasing is inherent to debounce/throttle here.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    lastThis = this;
    if (timeout !== null) clearTimeout(timeout);
    timeout = setTimeout(invoke, wait);
  } as DebouncedFunction<T>;

  debounced.flush = (): void => {
    if (timeout !== null) {
      clearTimeout(timeout);
      invoke();
    }
  };

  debounced.cancel = (): void => {
    if (timeout !== null) {
      clearTimeout(timeout);
      timeout = null;
    }
    lastArgs = null;
    lastThis = null;
  };

  return debounced;
}
