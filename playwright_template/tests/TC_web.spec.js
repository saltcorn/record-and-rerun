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
    let currentBenchmark = null;
    for (const event of testData.events) {
      if (!event || event.ignore) continue;
      switch (event.type) {
        case "page_info": {
          console.log(`Navigating to: ${event.url}`);
          const response = await page.goto(event.url);
          if (doBenchmark) {
            if (currentBenchmark) benchmarkResults.push(currentBenchmark);
            const benchData = await getBenchmarkMetrics(page);
            const correctStatus = response.status() === 200;
            benchData.correct = correctStatus ? 100 : 0;
            console.log(benchData);
            currentBenchmark = { url: event.url, ...benchData };
          }
          break;
        }
        case "click": {
          if (!event.selector) {
            console.log("No selector provided for click event, skipping.");
            break;
          }
          console.log(`Clicking on: ${event.selector}`);
          const element = await page.locator(event.selector);
          await element.click();
          await page.waitForTimeout(500);
          break;
        }
        case "keydown": {
          console.log(`Typing: ${event.key}`);
          if (event.key) {
            if (event.key.length > 1) {
              await page.keyboard.press(event.key);
              if (event.key === "Enter") {
                await page.waitForTimeout(500);
              }
            } else await page.keyboard.type(event.key);
          }
          break;
        }
        case "select": {
          if (!event.selector) {
            console.log("No selector provided for select event, skipping.");
            break;
          }
          console.log(`Selecting option: ${event.value} in ${event.selector}`);
          await page.locator(event.selector).selectOption(event.value);
          await page.waitForTimeout(200);
          break;
        }
        case "assert_text": {
          console.log(`Asserting text: ${event.text}`);
          const text = event.text;
          const content = await page.content();
          // plain case-insensitive substring check - a regex built from
          // raw recorded text would break on special characters like ( or $
          const contains = content.toLowerCase().includes(text.toLowerCase());
          if (!contains && doBenchmark && currentBenchmark) {
            currentBenchmark.correct = 0;
          }
          expect(contains).toBe(true);
          break;
        }
        case "assert_text_not_present": {
          console.log(`Asserting text not present: ${event.text}`);
          const text = event.text;
          const content = await page.content();
          const contains = content.toLowerCase().includes(text.toLowerCase());
          if (contains && doBenchmark && currentBenchmark) {
            currentBenchmark.correct = 0;
          }
          expect(contains).toBe(false);
          break;
        }
        case "assert_element": {
          if (!event.selector) {
            console.log("No selector provided for click event, skipping.");
            break;
          }
          console.log(`Asserting element: ${event.selector}`);
          const element = await page.locator(event.selector);
          await expect(element).toBeVisible();
          break;
        }
        default:
          console.log(`Unknown event type: ${event.type}`);
      }
    }

    if (doBenchmark) {
      await writeBenchmarkJSON(benchmarkResults);
    }
  });
});
