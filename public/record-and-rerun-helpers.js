const RecordAndRerun = (() => {
  class Recorder {
    constructor(cfg) {
      this.events = cfg.events || [];
      this.viewname = cfg.viewname;
      this.workflow = cfg.workflow;
      this.recording = cfg.recording || false;
      if (this.recording) this.startRecording();

      document.addEventListener("click", (event) => {
        if (this.recording) {
          const clickedElement = event.target;
          this.events.push({
            type: "click",
            tag: clickedElement.tagName,
            id: clickedElement.id,
            classes: clickedElement.className,
            x: event.clientX,
            y: event.clientY,
            timestamp: new Date().toISOString(),
          });
          persistEvents(this.events);
          if (this.events.length >= 10) this.uploadEvents();
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
      if (this.events.length >= 10) this.uploadEvents();
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
    JSON.parse(localStorage.getItem("web_recording_cfg") || "{}");
  const setCfg = (cfg) =>
    localStorage.setItem("web_recording_cfg", JSON.stringify(cfg));

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
