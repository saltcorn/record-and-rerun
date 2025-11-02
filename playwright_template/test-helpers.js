const path = require("path");
const fs = require("fs").promises;

const readEventsJSON = async (filePath) => {
  const data = await fs.readFile(path.join(__dirname, "events.json"), "utf-8");
  return JSON.parse(data);
};

const writeBenchmarkJSON = async (content) => {
  await fs.writeFile(
    path.join(
      __dirname,
      "benchmark_data",
      `benchmark_results_${new Date().valueOf()}.json`,
    ),
    JSON.stringify(content, null, 2),
  );
};

const getBenchmarkMetrics = async (page) => {
  const navTiming = await page.evaluate(() => {
    const [entry] = performance.getEntriesByType("navigation");
    return {
      responseEnd: entry.responseEnd,
      domComplete: entry.domComplete,
    };
  });

  const lcp = await page.evaluate(async () => {
    return new Promise((resolve) => {
      let lcpValue = 0;
      new PerformanceObserver((entryList, observer) => {
        for (const entry of entryList.getEntries()) {
          lcpValue = entry.startTime;
        }
        observer.disconnect();
        resolve(lcpValue);
      }).observe({ type: "largest-contentful-paint", buffered: true });
    });
  });
  const result = {
    responseEnd: navTiming.responseEnd,
    domComplete: navTiming.domComplete,
    LCP: lcp,
  };
  return result;
};

const dumpMobileHTML = async (page) => {
  const iframeHandle = await page.locator("iframe").elementHandle();
  if (iframeHandle) {
    const contentFrame = await iframeHandle.contentFrame();
    if (contentFrame) {
      const html = await contentFrame.content();
      console.log("Iframe HTML content:\n", html);
    } else console.error("Could not get iframe contentFrame.");
  } else console.error("Could not get iframe element handle.");
};

module.exports = {
  readEventsJSON,
  writeBenchmarkJSON,
  getBenchmarkMetrics,
  dumpMobileHTML,
};
