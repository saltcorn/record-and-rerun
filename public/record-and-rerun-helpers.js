const RecordAndRerun = (() => {
  class Recorder {
    constructor(cfg) {
      this.events = cfg.events || [];
      this.viewname = cfg.viewname;
      this.workflow = cfg.workflow;
      this.recording = cfg.recording || false;
      this.newSession = cfg.newSession || false;
      this.currentUrl = new URL(window.location.href);
      if (this.currentUrl.pathname === "/auth/login") {
        this.newSession = true;
        const oldCfg = getCfg();
        setCfg({ ...oldCfg, newSession: true });
      }
      if (this.recording && this.newSession) this.startRecording();
      this.initListeners();
    }

    checkUpload() {
      if (this.events.length >= 5 && this.currentUrl.pathname !== "/auth/login")
        this.uploadEvents();
    }

    recordingActive() {
      return this.recording && this.newSession;
    }

    initListeners() {
      document.addEventListener("keydown", (e) => {
        if (this.recording && this.newSession) {
          this.events.push({
            type: "keydown",
            key: e.key,
            code: e.code,
            timestamp: new Date().toISOString(),
          });
          persistEvents(this.events);
        }
      });

      document.addEventListener("click", (event) => {
        const assertMenu = document.querySelector(".custom-menu");
        if (assertMenu) assertMenu.remove();
        if (this.recording && this.newSession) {
          // ignore clicks on the custom context menu
          if (event.target.closest(".custom-menu")) return;

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
          if (this.checkUpload()) this.uploadEvents();
        }
      });

      document.addEventListener("contextmenu", (event) => {
        if (this.recording && this.newSession) {
          const selected = window.getSelection();
          const text = selected.toString().trim();
          if (text.length > 0) {
            event.preventDefault();
            const menu = document.createElement("div");
            menu.className = "custom-menu";
            menu.style.top = event.pageY + "px";
            menu.style.left = event.pageX + "px";
            const item = document.createElement("div");
            item.textContent = "Assert Text is present";
            item.onclick = () => {
              console.log("Assert Text is present clicked");
              this.events.push({
                type: "assert_text",
                text: text,
                timestamp: new Date().toISOString(),
              });
              persistEvents(this.events);
              if (this.checkUpload()) this.uploadEvents();
              selected.removeAllRanges();
            };
            menu.appendChild(item);
            document.body.appendChild(menu);
          }
        }
      });
    }

    startRecording() {
      this.recording = true;
      this.events.push({
        type: "page_info",
        url: window.location.href,
        width: window.innerWidth,
        height: window.innerHeight,
        timestamp: new Date().toISOString(),
      });
      persistEvents(this.events);
      if (this.checkUpload()) this.uploadEvents();
    }

    stopRecording() {
      const persisted = getPersistedEvents();
      if (persisted?.length > 0) {
        this.events = persisted;
        this.uploadEvents();
      }
      this.recording = false;
    }

    async uploadEvents() {
      if (this.events.length === 0) {
        console.log("No events to upload.");
        return;
      }

      const eventsToUpload = this.events.slice();
      this.events = [];
      persistEvents([]);

      try {
        const response = await fetch(`/view/${this.viewname}/upload_events`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CSRF-Token": _sc_globalCsrf,
          },
          body: JSON.stringify({
            events: eventsToUpload,
            workflow_id: this.workflow.id,
          }),
        });
        if (response.ok) {
          console.log("Events uploaded successfully.");
          this.events = [];
        } else throw new Error("Failed to upload events");
      } catch (error) {
        console.error("Error uploading events:", error);
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
          .map((attr) => `[${attr.name}="${CSS.escape(attr.value)}"]`)
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
      return selector;
    }
  };

  const initWorkflow = async (viewname, workflowName) => {
    try {
      const response = await fetch(`/view/${viewname}/init_workflow`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CSRF-Token": _sc_globalCsrf,
        },
        body: JSON.stringify({
          workflow_name: workflowName,
        }),
      });
      const result = await response.json();
      console.log("Init workflow response:", result);
      return result.created;
    } catch (error) {
      console.error("Error initializing workflow:", error);
    }
  };
  const startFromPublic = async (viewname, workflow) => {
    try {
      // call /auth/logout
      const response = await fetch("/auth/logout", {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "CSRF-Token": _sc_globalCsrf,
        },
      });
      if (!response.ok) throw new Error("Failed to logout");
      // redirect to home page
      window.location.href = window.location.origin;
    }
    catch (error) {
      console.error("Error starting from public:", error);
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
    box.className = "recording-bar";

    const nameEl = document.createElement("span");
    nameEl.textContent = `Recording: ${workflowName}`;

    const stopBtn = document.createElement("button");
    stopBtn.className = "stop-btn";
    stopBtn.innerHTML = `
      <svg viewBox="0 0 24 24">
        <rect x="6" y="6" width="12" height="12"></rect>
      </svg>
      Stop
    `;
    stopBtn.onclick = stopCallback;

    box.appendChild(nameEl);
    box.appendChild(stopBtn);
    document.body.appendChild(box);
  };

  const hideRecordingBox = () => {
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
    hideRecordingBox,
  };
})();
