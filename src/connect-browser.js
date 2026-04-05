import puppeteer from "puppeteer-core";

const CHROME_DEBUG_URL = "http://localhost:9222";

export async function connectToChrome({
  browserURL = CHROME_DEBUG_URL,
  timeoutMs = 5000,
} = {}) {
  let timeoutId;

  try {
    return await Promise.race([
      puppeteer.connect({
        browserURL,
        defaultViewport: null,
      }),
      new Promise((_, reject) => {
        // Promise.race does not cancel losers, so this timer must be cleared below
        // after a successful connect or it will keep the Node process alive.
        timeoutId = setTimeout(
          () => reject(new Error(`Connection timeout after ${timeoutMs / 1000}s`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
