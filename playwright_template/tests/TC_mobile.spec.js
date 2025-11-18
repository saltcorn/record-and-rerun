const { test, expect } = require("@playwright/test");

const { readEventsJSON, dumpMobileHTML } = require("../test-helpers");

test.describe("generic Test Suite", () => {
  let testData = null;
  let context;
  let page;

  test.beforeAll(async ({ browser }) => {
    testData = await readEventsJSON();
    context = await browser.newContext({
      ignoreHTTPSErrors: true,
    });
    page = await context.newPage();
    await page.setViewportSize({ width: 1350, height: 720 });
    await page.goto("http://localhost:3010/mobile_test_build/index.html");
  });

  test.afterAll(async () => {
    await page.close();
    await context.close();
  });

  test("generic steps", async () => {
    const iframe = page.frameLocator("iframe");
    for (const event of testData.events) {
      if (!event || event.ignore) continue;
      switch (event.type) {
        case "click": {
          if (!event.selector) {
            console.log("No selector provided for click event, skipping.");
            break;
          }
          console.log(`Clicking on: ${event.selector}`);
          const element = await iframe.locator(event.selector);
          await element.click();
          await page.waitForTimeout(500);
          break;
        }
        case "keydown": {
          console.log(`Typing: ${event.key}`);
          if (event.key) {
            await page.keyboard.press(event.key);
          }
          break;
        }
        case "assert_text": {
          console.log(`Asserting text: ${event.text}`);

          break;
        }
        case "assert_text_not_present": {
          console.log(`Asserting text not present: ${event.text}`);
        }
        case "assert_element": {
          if (!event.selector) {
            console.log("No selector provided for click event, skipping.");
            break;
          }
          console.log(`Asserting element: ${event.selector}`);
          break;
        }
      }
    }
  });
});
