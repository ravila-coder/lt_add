// Analysis engine: Python (Pyodide) in a Web Worker, so the page never freezes.
// Loads app.py and drives it through bridge.py. Files are processed in this browser
// tab and are never uploaded anywhere.
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
importScripts(PYODIDE + "pyodide.js");

const WHEELS = [
  "blinker-1.9.0-py3-none-any.whl",
  "click-8.1.8-py3-none-any.whl",
  "itsdangerous-2.2.0-py3-none-any.whl",
  "werkzeug-3.1.3-py3-none-any.whl",
  "flask-3.1.3-py3-none-any.whl",
  "et_xmlfile-2.0.0-py3-none-any.whl",
  "openpyxl-3.1.5-py2.py3-none-any.whl",
];
// web path -> name app.py expects on its own disk
const APP_FILES = {
  "py/app.py": "app.py",
  "py/bridge.py": "bridge.py",
  "py/template.xlsx": "Portfolio Analysis.xlsx",
  "py/Theme1.thmx": "Theme1.thmx",
};
const base = new URL(".", self.location.href).href;
const status = text => self.postMessage({ type: "status", text });

async function boot() {
  status("Cargando Python...");
  const py = await loadPyodide({ indexURL: PYODIDE });
  status("Cargando librerías...");
  await py.loadPackage(["micropip", "sqlite3", "pillow", "markupsafe", "jinja2"]);
  const micropip = py.pyimport("micropip");
  await micropip.install(WHEELS.map(w => base + "wheels/" + w), { deps: false });
  py.FS.mkdirTree("/app");
  for (const [src, dst] of Object.entries(APP_FILES)) {
    const r = await fetch(base + src, { cache: "no-cache" });
    if (!r.ok) throw new Error(`No se pudo cargar ${src} (${r.status})`);
    py.FS.writeFile("/app/" + dst, new Uint8Array(await r.arrayBuffer()));
  }
  py.runPython("import sys; sys.path.insert(0, '/app')");
  const call = py.pyimport("bridge").call;
  self.postMessage({ type: "ready" });
  return { py, call };
}

const engine = boot();
engine.catch(e => self.postMessage({ type: "fatal", text: String(e && e.message || e) }));

// Python is single threaded: run requests strictly one after another.
let queue = Promise.resolve();
self.onmessage = e => {
  const m = e.data;
  queue = queue.then(() => handle(m));
};

async function handle({ id, method, path, body, file }) {
  try {
    const { py, call } = await engine;
    const data = file ? new Uint8Array(file.buf) : null;
    const res = call(method, path, body || null, file ? file.name : null, data);
    const [status, ctype, payload] = res.toJs();
    res.destroy();
    const buf = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    self.postMessage({ id, status, ctype, buf }, [buf.buffer]);
  } catch (err) {
    const text = String(err && err.message || err);
    // keep the last line of a Python traceback, it names the actual error
    const last = text.trim().split("\n").filter(Boolean).pop() || text;
    self.postMessage({ id, error: last, detail: text });
  }
}
