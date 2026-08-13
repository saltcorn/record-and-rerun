const RecordAndRerun = (() => {
  const isNode = typeof parent.saltcorn?.mobileApp === "undefined";
  class Recorder {
    constructor(cfg) {
      this.events = cfg.events || [];
      this.viewname = cfg.viewname;
      this.workflow = cfg.workflow;
      this.recording = cfg.recording || false;
      this.api_token = cfg.api_token;
      this.currentUrl = new URL(window.location.href);
      this.inErrorState = false;
      this.lastMouseDownEl = null;
      this.lastWasGenerated = false;
      this.lastClickedEl = null;
      this.lastSelectedText = "";
      this.inputBaselines = new WeakMap();
      this.uploadTimer = null;
      if (this.recording) this.initListeners();
    }

    checkUpload() {
      // the token-authenticated /scapi route still redirects to
      // /auth/login while logged out, so an api_token doesn't help here -
      // never upload until there's a session again
      if (!isNode) {
        // mobile's login page doesn't change window.location, so ask the
        // app directly whether we have a session instead
        const hasSession =
          parent.saltcorn?.data?.state?.getState?.()?.mobileConfig?.hasSession;
        if (hasSession === false) return false;
      } else if (this.currentUrl.pathname === "/auth/login") {
        return false;
      }
      return this.events.length >= 5;
    }

    // debounced so an upload doesn't fire on the same tick as a click that
    // also triggers app navigation - on mobile, both go through Capacitor's
    // native HTTP layer, and racing requests there can drop the session
    // cookie on one of them
    scheduleUpload() {
      if (this.uploadTimer) clearTimeout(this.uploadTimer);
      this.uploadTimer = setTimeout(() => {
        this.uploadTimer = null;
        this.uploadEvents();
      }, 1000);
    }

    initListeners() {
      if (isNode) {
        document.addEventListener("keydown", (e) => {
          if (this.recording) {
            this.events.push({
              type: "keydown",
              key: e.key,
              code: e.code,
              timestamp: new Date().toISOString(),
            });
            persistEvents(this.events);
          }
        });
      } else {
        // mobile can't track keystrokes, so watch "input" on fields instead,
        // delegated on document so fields added later are picked up too
        document.addEventListener(
          "focusin",
          (e) => {
            if (this.recording && e.target?.matches?.("input, textarea")) {
              // baseline is the value at the moment the field is focused,
              // so pre-filled/default values aren't misread as user input
              this.inputBaselines.set(e.target, e.target.value);
            }
          },
          true
        );
        document.addEventListener("input", (e) => {
          const target = e.target;
          if (!this.recording || !target?.matches?.("input, textarea")) return;
          const newValue = target.value;
          const oldValue = this.inputBaselines.has(target)
            ? this.inputBaselines.get(target)
            : "";
          const { removed, inserted } = diffValues(oldValue, newValue);
          if (removed || inserted) {
            const selector = getUniqueSelector(target);
            const timestamp = new Date().toISOString();
            // split into delete/insert so edits mid-word (e.g. autocorrect)
            // and multi-character deletes replay accurately
            if (removed) {
              this.events.push({
                type: "keydown",
                selector,
                key: "Backspace",
                count: removed.length,
                timestamp,
              });
            }
            if (inserted) {
              this.events.push({
                type: "keydown",
                selector,
                key: inserted,
                code: inserted,
                timestamp,
              });
            }
            persistEvents(this.events);
          }
          this.inputBaselines.set(target, newValue);
        });
        // track selected text for the mobile assert-menu, since long-press
        // selection doesn't reliably trigger a "contextmenu" on mobile
        document.addEventListener("selectionchange", () => {
          if (this.recording) {
            const selected = window.getSelection();
            this.lastSelectedText = selected ? selected.toString() : "";
          }
        });
      }

      document.addEventListener("change", (e) => {
        if (this.recording && e.target?.tagName === "SELECT") {
          this.events.push({
            type: "select",
            selector: getUniqueSelector(e.target),
            value: e.target.value,
            timestamp: new Date().toISOString(),
          });
          persistEvents(this.events);
          if (this.checkUpload()) this.scheduleUpload();
        }
      });

      document.addEventListener(
        "mousedown",
        (e) => {
          this.lastMouseDownEl = e.target;
        },
        true
      );

      const oldFn = window.pjax_to;
      const that = this;
      window.pjax_to = function (href, e) {
        if (that.recording && that.lastMouseDownEl) {
          const selector = getUniqueSelector(that.lastMouseDownEl);
          const eventData = {
            type: "click",
            selector: selector,
            timestamp: new Date().toISOString(),
          };
          that.lastWasGenerated = true;
          that.events.push(eventData);
          persistEvents(that.events);
        }
        oldFn.call(this, href, e);
      };

      document.addEventListener("click", async (event) => {
        const _lastMouseDownEl = this.lastMouseDownEl;
        this.lastMouseDownEl = null;

        const assertMenu = document.querySelector(".custom-menu");
        if (assertMenu) assertMenu.remove();
        if (this.recording) {
          if (_lastMouseDownEl === event.target && this.lastWasGenerated) {
            this.lastWasGenerated = false;
            return;
          }

          // ignore clicks on the custom context menu
          if (event.target.closest(".custom-menu")) return;

          // ignore clicks .toast-header
          if (event.target.closest(".toast-header")) return;

          // ignore clicks on the recording bar
          if (event.target.closest(".recording-bar")) return;

          // ignore 'Enter' when followed by a synthetic click
          const element = event.target;
          if (
            element.tagName === "BUTTON" &&
            element.type === "submit" &&
            !event.pointerType
          ) {
            const lastEvent = this.events[this.events.length - 1];
            if (
              lastEvent &&
              lastEvent.type === "keydown" &&
              lastEvent.key === "Enter"
            ) {
              lastEvent.ignore = true;
            }
          }
          const selector = getUniqueSelector(event.target);
          const eventData = {
            type: "click",
            selector: selector || null,
            timestamp: new Date().toISOString(),
          };
          this.events.push(eventData);
          this.lastClickedEl = event.target;
          persistEvents(this.events);
          if (this.checkUpload()) this.scheduleUpload();
        }
      });

      document.addEventListener("contextmenu", (event) => {
        this.lastMouseDownEl = null;
        // mobile has its own Assert button - a touch-and-hold can still
        // fire "contextmenu" on some devices, so keep this menu web-only
        // to avoid showing two different assert menus
        if (this.recording && isNode) {
          event.preventDefault();
          const selected = window.getSelection();
          const text = selected.toString().trim();
          const menu = document.createElement("div");
          menu.className = "custom-menu";
          menu.style.top = event.pageY + "px";
          menu.style.left = event.pageX + "px";

          // assert text present
          if (text.length > 0) {
            const textPresentItem = document.createElement("div");
            textPresentItem.textContent = "Assert Text is present";
            textPresentItem.onclick = async () => {
              this.events.push({
                type: "assert_text",
                text: text,
                timestamp: new Date().toISOString(),
              });
              persistEvents(this.events);
              if (this.checkUpload()) this.scheduleUpload();
              selected.removeAllRanges();
            };
            menu.appendChild(textPresentItem);
          }

          // assert text not present
          const textNotPresentItem = document.createElement("div");
          textNotPresentItem.textContent = "Assert Text is not present";
          textNotPresentItem.onclick = async () => {
            // prompt for the text to assert not present
            let textNotPresent = prompt(
              "Enter the text to assert is not present:",
              text
            );
            if (textNotPresent && textNotPresent.trim().length > 0) {
              this.events.push({
                type: "assert_text_not_present",
                text: textNotPresent.trim(),
                timestamp: new Date().toISOString(),
              });
              persistEvents(this.events);
              if (this.checkUpload()) this.scheduleUpload();
            }
          };
          menu.appendChild(textNotPresentItem);

          // assert element present
          const elementPresentItem = document.createElement("div");
          elementPresentItem.textContent = "Assert Element is present";
          elementPresentItem.onclick = async () => {
            const element = event.target;
            const selector = getUniqueSelector(element);
            this.events.push({
              type: "assert_element",
              selector: selector,
              timestamp: new Date().toISOString(),
            });
            persistEvents(this.events);
            if (this.checkUpload()) this.scheduleUpload();
            selected.removeAllRanges();
          };
          menu.appendChild(elementPresentItem);
          document.body.appendChild(menu);
        }
      });
    }

    // mobile fallback for the web assert-menu, which relies on
    // "contextmenu" - unreliable on touch devices
    async assertTextPresent() {
      const text = (this.lastSelectedText || "").trim();
      if (!text) {
        const msg = "Select some text first, then tap Assert Text is present";
        if (typeof notifyAlert === "function")
          notifyAlert({ type: "danger", text: msg });
        else console.error(msg);
        return;
      }
      this.events.push({
        type: "assert_text",
        text,
        timestamp: new Date().toISOString(),
      });
      persistEvents(this.events);
      if (this.checkUpload()) this.scheduleUpload();
    }

    async assertTextNotPresent() {
      const textNotPresent = prompt(
        "Enter the text to assert is not present:",
        this.lastSelectedText || ""
      );
      if (textNotPresent && textNotPresent.trim().length > 0) {
        this.events.push({
          type: "assert_text_not_present",
          text: textNotPresent.trim(),
          timestamp: new Date().toISOString(),
        });
        persistEvents(this.events);
        if (this.checkUpload()) this.scheduleUpload();
      }
    }

    // uses the last tapped element (tracked by the click listener) as the
    // assert target, since there is no long-press/right-click equivalent
    async assertElementPresent() {
      if (!this.lastClickedEl) {
        const msg = "Tap the element you want to assert first";
        if (typeof notifyAlert === "function")
          notifyAlert({ type: "danger", text: msg });
        else console.error(msg);
        return;
      }
      const selector = getUniqueSelector(this.lastClickedEl);
      // that tap was only to pick the assert target, not a real
      // interaction - drop the click event it generated
      const lastEvent = this.events[this.events.length - 1];
      if (
        lastEvent &&
        lastEvent.type === "click" &&
        lastEvent.selector === selector
      ) {
        this.events.pop();
      }
      this.events.push({
        type: "assert_element",
        selector,
        timestamp: new Date().toISOString(),
      });
      persistEvents(this.events);
      this.lastClickedEl = null;
      if (this.checkUpload()) this.scheduleUpload();
    }

    async startRecording() {
      this.recording = true;
      if (isNode) {
        this.events.push({
          type: "page_info",
          url: window.location.href,
          width: window.innerWidth,
          height: window.innerHeight,
          timestamp: new Date().toISOString(),
        });
        persistEvents(this.events);
        if (this.checkUpload()) this.scheduleUpload();
      }
    }

    async stopRecording() {
      if (this.uploadTimer) {
        clearTimeout(this.uploadTimer);
        this.uploadTimer = null;
      }
      this.events = getPersistedEvents();
      await this.uploadEvents(true);
      this.recording = false;
    }

    // uploads race over the network if triggered while a previous upload is
    // still in flight, which can insert events out of chronological order -
    // chain calls so each one waits for the last to finish first
    uploadEvents(hasStopped = false) {
      this.uploadChain = (this.uploadChain || Promise.resolve())
        .catch(() => {})
        .then(() => this._doUpload(hasStopped));
      return this.uploadChain;
    }

    async _doUpload(hasStopped = false) {
      if (!hasStopped && this.events.length === 0) {
        console.log("No events to upload.");
        return;
      }

      const eventsToUpload = this.events.slice();
      this.events = [];
      persistEvents([]);

      try {
        const body = {
          events: eventsToUpload,
          workflow_id: this.workflow.id,
          has_stopped: hasStopped,
        };
        let url = null;
        if (this.api_token) {
          body.access_token = this.api_token;
          url = `/scapi/run-view-route/${this.viewname}/upload_events`;
        } else {
          url = `/view/${this.viewname}/upload_events`;
        }
        if (isNode) {
          const response = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "CSRF-Token": _sc_globalCsrf,
              "X-Requested-With": "XMLHttpRequest",
            },
            body: JSON.stringify(body),
          });
          // okay for /scapi, not redirect for /view
          if (response.ok && !response.redirected) {
            const result = await response.json();
            if (result.error) throw new Error(result.error);
            console.log("Events uploaded successfully.");
          } else
            throw new Error(
              `Failed to upload events${
                this.api_token ? "" : ": No API token configured"
              }`
            );
        } else {
          const response = await parent.saltcorn.mobileApp.api.apiCall({
            method: "POST",
            path: url,
            body: body,
          });
          if (response.error) throw new Error(response.error);
          console.log("Events uploaded successfully.");
        }
        this.inErrorState = false;
      } catch (error) {
        console.error("Error uploading events:", error);
        // notifyAlert isn't defined on every page (e.g. the login page) -
        // guard it so a missing global can't skip the requeue below and
        // silently drop these events
        if (!this.inErrorState) {
          if (typeof notifyAlert === "function") {
            notifyAlert({
              type: "danger",
              text: error.message || "Error uploading events",
            });
          }
          this.inErrorState = true;
        }
        this.events = eventsToUpload.concat(this.events);
        // keep the persisted copy in sync so a reload before the next
        // retry doesn't lose these events
        persistEvents(this.events);
      }
    }
  }

  // figures out what changed between an old and new field value, even if
  // the edit happened in the middle rather than at the end
  const diffValues = (oldValue, newValue) => {
    const maxPrefix = Math.min(oldValue.length, newValue.length);
    let prefixLen = 0;
    while (
      prefixLen < maxPrefix &&
      oldValue[prefixLen] === newValue[prefixLen]
    ) {
      prefixLen++;
    }
    const maxSuffix = Math.min(oldValue.length, newValue.length) - prefixLen;
    let suffixLen = 0;
    while (
      suffixLen < maxSuffix &&
      oldValue[oldValue.length - 1 - suffixLen] ===
        newValue[newValue.length - 1 - suffixLen]
    ) {
      suffixLen++;
    }
    return {
      removed: oldValue.slice(prefixLen, oldValue.length - suffixLen),
      inserted: newValue.slice(prefixLen, newValue.length - suffixLen),
    };
  };

  const getUniqueSelector = (element) => {
    if (element === document.body) return "body";
    if (element.id) return `#${element.id}`;
    if (element.hasAttribute("data-row-id")) {
      return `${element.tagName.toLowerCase()}[data-row-id="${CSS.escape(
        element.getAttribute("data-row-id")
      )}"]`;
    }
    if (element.hasAttribute("row-key")) {
      return `${element.tagName.toLowerCase()}[row-key="${CSS.escape(
        element.getAttribute("row-key")
      )}"]`;
    }
    if (element.tagName === "BUTTON" && element.type === "submit") {
      const form = element.closest("form");
      if (form) {
        const actionWithoutDomain = form.action.startsWith("http")
          ? new URL(form.action).pathname
          : form.action;
        return `form[action="${actionWithoutDomain}"] button[type="submit"]`;
      }
    } else {
      const attrs = Array.from(element.attributes).map((attr) => ({
        name: attr.name,
        value: attr.value,
      }));
      let selector =
        element.tagName.toLowerCase() +
        attrs
          .map((attr) => {
            if (attr.name === "class") {
              const classes = attr.value
                .split(" ")
                .filter((cls) => cls.trim().length > 0)
                .map((cls) => `.${CSS.escape(cls)}`)
                .join("");
              return classes;
            }
            return `[${attr.name}="${CSS.escape(attr.value)}"]`;
          })
          .join("");
      const matches = document.querySelectorAll(selector);
      if (matches.length > 1) {
        const parent = element.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(
            (el) => el.tagName === element.tagName
          );
          const index = siblings.indexOf(element) + 1;
          const parentSelector = getUniqueSelector(parent);
          selector = `${parentSelector} > ${element.tagName.toLowerCase()}:nth-of-type(${index})`;
        }
      }
      if (!selector)
        console.warn("Could not generate selector for element:", element);
      return selector;
    }
  };

  const initWorkflow = async (viewname, workflowName) => {
    try {
      let result = null;
      const path = `/view/${viewname}/init_workflow`;
      if (isNode) {
        const response = await fetch(path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CSRF-Token": _sc_globalCsrf,
            "X-Requested-With": "XMLHttpRequest",
          },
          body: JSON.stringify({
            workflow_name: workflowName,
            workflow_type: "Web",
          }),
        });
        result = await response.json();
      } else {
        const response = await parent.saltcorn.mobileApp.api.apiCall({
          method: "POST",
          path,
          body: {
            workflow_name: workflowName,
            workflow_type: "Mobile",
          },
        });
        result = response.data;
      }
      console.log("Init workflow response:", result);
      return { workflow: result.created, api_token: result.api_token };
    } catch (error) {
      console.error("Error initializing workflow:", error);
      notifyAlert({
        type: "danger",
        text: error.message || "Error initializing workflow",
      });
    }
  };
  const startFromPublic = async () => {
    try {
      if (isNode) {
        // call /auth/logout
        const response = await fetch("/auth/logout", {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "CSRF-Token": _sc_globalCsrf,
            "X-Requested-With": "XMLHttpRequest",
          },
        });
        if (!response.ok) throw new Error("Failed to logout");
        // redirect to home page
        window.location.href = window.location.origin;
      } else {
        await parent.saltcorn.mobileApp.auth.logout();
      }
      return true;
    } catch (error) {
      console.error("Error starting from public:", error);
      notifyAlert({
        type: "danger",
        text: error.message || "Error starting from public",
      });
      return false;
    }
  };
  const getCfg = () =>
    JSON.parse(sessionStorage.getItem("web_recording_cfg") || "{}");
  const setCfg = (cfg) =>
    sessionStorage.setItem("web_recording_cfg", JSON.stringify(cfg));

  const persistEvents = (events) => {
    const oldCfg = getCfg();
    oldCfg.events = events;
    setCfg(oldCfg);
  };

  const getPersistedEvents = () => {
    const cfg = getCfg();
    return cfg.events || [];
  };

  const showRecordingBox = (workflowName, stopCallback, isMobile) => {
    const box = document.createElement("div");
    const boxHtml = `
  <div class="recording-bar">
    <div class="recording-controls">
      <span>Recording: ${workflowName}</span>
      ${
        isMobile
          ? `<button class="assert-btn" id="assert-menu-btn">Assert</button>`
          : ""
      }
      <button class="stop-btn" id="stop-recording-id">
        <svg viewBox="0 0 24 24">
          <rect x="6" y="6" width="12" height="12"></rect>
        </svg>
        Stop
      </button>
    </div>
    ${
      isMobile
        ? `<div class="assert-menu" id="assert-menu" style="display: none;">
      <div id="assert-text-present-item">Assert Text is present</div>
      <div id="assert-text-not-present-item">Assert Text is not present</div>
      <div id="assert-element-present-item">Assert Element is present</div>
    </div>`
        : ""
    }
  </div>`;
    box.innerHTML = boxHtml;
    const stopBtn = box.querySelector("#stop-recording-id");
    stopBtn.onclick = stopCallback;
    if (isMobile) {
      const menu = box.querySelector("#assert-menu");
      box.querySelector("#assert-menu-btn").onclick = () => {
        menu.style.display = menu.style.display === "none" ? "block" : "none";
      };
      box.querySelector("#assert-text-present-item").onclick = async () => {
        menu.style.display = "none";
        await RecordAndRerun.recorder.assertTextPresent();
      };
      box.querySelector("#assert-text-not-present-item").onclick = async () => {
        menu.style.display = "none";
        await RecordAndRerun.recorder.assertTextNotPresent();
      };
      box.querySelector("#assert-element-present-item").onclick = async () => {
        menu.style.display = "none";
        await RecordAndRerun.recorder.assertElementPresent();
      };
    }
    document.body.appendChild(box);
  };

  const removeRecordingBox = () => {
    const box = document.querySelector(".recording-bar");
    if (box) box.remove();
  };

  return {
    getCfg,
    setCfg,
    initWorkflow,
    startFromPublic,
    Recorder,
    recorder: new Recorder(getCfg()),
    showRecordingBox,
    removeRecordingBox,
    isMobile: !isNode,
  };
})();
