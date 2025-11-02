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
      if (this.recording) this.initListeners();
    }

    checkUpload() {
      if (this.currentUrl.pathname === "/auth/login" && !this.api_token)
        return false;
      else return this.events.length >= 5;
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
        // trackging keystrokes seems not to be permitted on mobile
        // add onChangeListener to all input and textarea elements and handle changes as keystrokes
        const elements = document.querySelectorAll("input, textarea");
        for (const element of elements) {
          element.setAttribute("_sc_old-value_", element.value);
          element.addEventListener("input", (e) => {
            if (this.recording) {
              const newValue = e.target.value;
              const oldValue = e.target.getAttribute("_sc_old-value_") || "";
              let changeType, changeValue;
              if (newValue.length > oldValue.length) {
                changeType = "insert";
                changeValue = newValue.slice(oldValue.length);
              } else if (newValue.length < oldValue.length) {
                changeType = "delete";
                changeValue = oldValue.slice(newValue.length);
              }
              if (change) {
                this.events.push({
                  type: "keydown",
                  selector: getUniqueSelector(e.target),
                  key: changeType === "delete" ? "Backspace" : changeValue,
                  code: changeType === "delete" ? "Backspace" : changeValue,
                  timestamp: new Date().toISOString(),
                });
                persistEvents(this.events);
              }
              element.setAttribute("_sc_old-value_", newValue);
            }
          });
        }
      }

      document.addEventListener(
        "mousedown",
        (e) => {
          this.lastMouseDownEl = e.target;
        },
        true,
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
          persistEvents(this.events);
          if (this.checkUpload()) await this.uploadEvents();
        }
      });

      document.addEventListener("contextmenu", (event) => {
        this.lastMouseDownEl = null;
        if (this.recording) {
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
              if (this.checkUpload()) await this.uploadEvents();
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
              text,
            );
            if (textNotPresent && textNotPresent.trim().length > 0) {
              this.events.push({
                type: "assert_text_not_present",
                text: textNotPresent.trim(),
                timestamp: new Date().toISOString(),
              });
              persistEvents(this.events);
              if (this.checkUpload()) await this.uploadEvents();
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
            if (this.checkUpload()) await this.uploadEvents();
            selected.removeAllRanges();
          };
          menu.appendChild(elementPresentItem);
          document.body.appendChild(menu);
        }
      });
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
        if (this.checkUpload()) await this.uploadEvents();
      }
    }

    async stopRecording() {
      this.events = getPersistedEvents();
      await this.uploadEvents(true);
      this.recording = false;
    }

    async uploadEvents(hasStopped = false) {
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
            this.events = [];
          } else
            throw new Error(
              `Failed to upload events${
                this.api_token ? "" : ": No API token configured"
              }`,
            );
        } else {
          const response = await parent.saltcorn.mobileApp.api.apiCall({
            method: "POST",
            path: url,
            body: body,
          });
          if (response.error) throw new Error(response.error);
          console.log("Events uploaded successfully.");
          this.events = [];
        }
        this.inErrorState = false;
      } catch (error) {
        console.error("Error uploading events:", error);
        if (!this.inErrorState) {
          notifyAlert({
            type: "danger",
            text: error.message || "Error uploading events",
          });
          this.inErrorState = true;
        }
        this.events = eventsToUpload.concat(this.events);
      }
    }
  }

  const getUniqueSelector = (element) => {
    if (element === document.body) return "body";
    if (element.id) return `#${element.id}`;
    if (element.hasAttribute("data-row-id")) {
      return `${element.tagName.toLowerCase()}[data-row-id="${CSS.escape(
        element.getAttribute("data-row-id"),
      )}"]`;
    }
    if (element.hasAttribute("row-key")) {
      return `${element.tagName.toLowerCase()}[row-key="${CSS.escape(
        element.getAttribute("row-key"),
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
            (el) => el.tagName === element.tagName,
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

  const showRecordingBox = (workflowName, stopCallback) => {
    const box = document.createElement("div");
    const boxHtml = `
  <div class="recording-bar">
    <div class="recording-controls">
      <span>Recording: ${workflowName}</span>
      <button class="stop-btn" id="stop-recording-id">
        <svg viewBox="0 0 24 24">
          <rect x="6" y="6" width="12" height="12"></rect>
        </svg>
        Stop
      </button>
    </div>
  </div>`;
    box.innerHTML = boxHtml;
    const stopBtn = box.querySelector("#stop-recording-id");
    stopBtn.onclick = stopCallback;
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
  };
})();
