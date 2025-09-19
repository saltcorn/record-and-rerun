const { test, expect } = require("@playwright/test");

const {
  readEventsJSON,
  writeBenchmarkJSON,
  getBenchmarkMetrics,
} = require("../test-helpers");

const doBenchmark = process.env.DO_BENCHMARK === "true";
console.log(`Benchmarking is ${doBenchmark ? "enabled" : "disabled"}`);

test.describe("generic Test Suite", () => {
  let testData = null;
  let page = null;
  let context = null;
  test.beforeAll(async ({ browser }) => {
    testData = await readEventsJSON();
    context = await browser.newContext({
      ignoreHTTPSErrors: true,
    });
    page = await context.newPage();
    const { width, height } = testData.events[0];
    await page.setViewportSize({ width: width || 1280, height: height || 720 });
  });
  test("generic steps", async ({ browser }) => {
    const benchmarkResults = [];
    for (const event of testData.events) {
      if (event.ignore) continue;
      switch (event.type) {
        case "page_info":
          console.log(`Navigating to: ${event.url}`);
          const oldUrl = event.url;
          await page.goto(oldUrl.replace(/:\d+/, ":3010"));
          if (doBenchmark) {
            const benchData = await getBenchmarkMetrics(page);
            console.log(benchData);
            benchmarkResults.push({ url: oldUrl, ...benchData });
          }
          break;
        case "click":
          console.log(`Clicking on: ${event.selector}`);
          const element = await page.locator(event.selector);
          await element.click();
          await page.waitForTimeout(500);
          break;
        case "keydown":
          console.log(`Typing: ${event.key}`);
          if (event.key) {
            if (event.key.length > 1) await page.keyboard.press(event.key);
            else await page.keyboard.type(event.key);
          }
          break;
        case "assert_text":
          console.log(`Asserting text: ${event.text}`);
          const text = event.text;
          const content = await page.content();
          expect(content).toMatch(new RegExp(text, "i"));
          break;
        default:
          console.log(`Unknown event type: ${event.type}`);
      }
    }

    if (doBenchmark) {
      await writeBenchmarkJSON(benchmarkResults);
    }
  });
});
