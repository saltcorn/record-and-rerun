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
      this.ignoreNextClick = false;
      this.initListeners();
    }

    checkUpload() {
      if (this.events.length >= 5 && this.currentUrl.pathname !== "/auth/login")
        this.uploadEvents();
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
        if (this.recording && this.newSession) {
          if (this.ignoreNextClick) {
            this.ignoreNextClick = false;
            return;
          }

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

      document.addEventListener("mouseup", () => {
        if (this.recording && this.newSession) {
          const selected = window.getSelection();
          const text = selected.toString().trim();
          if (text) {
            this.ignoreNextClick = true;
            if (
              confirm("Assert that the following text is present:\n\n" + text)
            ) {
              this.events.push({
                type: "assert_text",
                text: text,
                timestamp: new Date().toISOString(),
              });
              persistEvents(this.events);
              if (this.checkUpload()) this.uploadEvents();
              selected.removeAllRanges();
            }
          }
        }
      });

      document.addEventListener("dblclick", () => {
        if (this.recording && this.newSession) {
          const selected = window.getSelection();
          const text = selected.toString().trim();
          if (text) {
            this.ignoreNextClick = true;

            if (
              confirm("Assert that the following text is present:\n\n" + text)
            ) {
              this.events.push({
                type: "assert_text",
                text: text,
                timestamp: new Date().toISOString(),
              });
              persistEvents(this.events);
              if (this.checkUpload()) this.uploadEvents();
              selected.removeAllRanges();
            }
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
      if (attrs.length === 0) return getUniqueSelector(element.parentElement);

      const attrSelector = attrs
        .map((attr) => `[${attr.name}="${CSS.escape(attr.value)}"]`)
        .join("");
      const selector = element.tagName.toLowerCase() + attrSelector;
      const matches = document.querySelectorAll(selector);
      if (matches.length > 1) {
        const parentTagName = element.parentElement.tagName.toLowerCase();
        return `${parentTagName} > ${selector}`;
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

  return {
    getCfg,
    setCfg,
    initWorkflow,
    Recorder,
    recorder: new Recorder(getCfg()),
  };
})();
