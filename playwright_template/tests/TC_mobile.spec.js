const { test, expect } = require("@playwright/test");

const {
  readEventsJSON,
  writeBenchmarkJSON,
  getBenchmarkMetrics,
  dumpMobileHTML,
} = require("../test-helpers");

const serverPath = process.env.TEST_SERVER || "http://localhost:3010";
const doBenchmark = process.env.DO_BENCHMARK === "true";

test.describe("generic Test Suite", () => {
  let testData = null;
  let context;
  let page;
  let indexUrl;

  test.beforeAll(async ({ browser }) => {
    testData = await readEventsJSON();
    context = await browser.newContext({
      ignoreHTTPSErrors: true,
    });
    page = await context.newPage();
    await page.setViewportSize({ width: 1350, height: 720 });
    indexUrl = `${serverPath}/mobile_test_build/index.html`;
    await page.goto(indexUrl);
  });

  test.afterAll(async () => {
    await page.close();
    await context.close();
  });

  test("generic steps", async () => {
    const iframe = page.frameLocator("iframe");
    let completed = false;
    try {
      for (const event of testData.events) {
        if (!event || event.ignore) continue;
        switch (event.type) {
          case "click": {
            if (!event.selector) {
              console.log("No selector provided for click event, skipping.");
              break;
            }
            console.log(`Clicking on: ${event.selector}`);
            await iframe.locator(event.selector).click();
            await page.waitForTimeout(500);
            break;
          }
          case "keydown": {
            if (!event.key) break;
            console.log(`Typing: ${event.key}`);
            if (event.selector) {
              // recorded per input field on mobile - focus it explicitly
              // rather than assuming an earlier click left it focused
              await iframe.locator(event.selector).focus();
            }
            if (event.key === "Backspace") {
              // event.count is how many characters were actually removed
              // in the recorded edit (defaults to 1 for older recordings)
              const count = event.count || 1;
              for (let i = 0; i < count; i++) {
                await page.keyboard.press("Backspace");
              }
            } else {
              // mobile records whole inserted chunks of text, not single
              // keys, so this has to be typed rather than pressed
              await page.keyboard.type(event.key);
            }
            await page.waitForTimeout(200);
            break;
          }
          case "select": {
            if (!event.selector) {
              console.log("No selector provided for select event, skipping.");
              break;
            }
            console.log(`Selecting option: ${event.value} in ${event.selector}`);
            await iframe.locator(event.selector).selectOption(event.value);
            await page.waitForTimeout(200);
            break;
          }
          case "assert_text": {
            console.log(`Asserting text: ${event.text}`);
            await expect(iframe.locator("body")).toContainText(event.text, {
              ignoreCase: true,
            });
            break;
          }
          case "assert_text_not_present": {
            console.log(`Asserting text not present: ${event.text}`);
            await expect(iframe.locator("body")).not.toContainText(
              event.text,
              { ignoreCase: true },
            );
            break;
          }
          case "assert_element": {
            if (!event.selector) {
              console.log("No selector provided for assert event, skipping.");
              break;
            }
            console.log(`Asserting element: ${event.selector}`);
            await expect(iframe.locator(event.selector)).toBeVisible();
            break;
          }
          default:
            console.log(`Unknown event type: ${event.type}`);
        }
      }
      completed = true;
    } catch (err) {
      await dumpMobileHTML(page);
      throw err;
    } finally {
      if (doBenchmark) {
        // there's only one real navigation here (the app shell) - later
        // steps swap iframe content rather than navigate, so this is the
        // only point that can carry real load-time metrics
        const benchData = await getBenchmarkMetrics(page);
        benchData.url = indexUrl;
        benchData.correct = completed ? 100 : 0;
        await writeBenchmarkJSON([benchData]);
      }
    }
  });
});
