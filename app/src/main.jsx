import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import { theme } from "./theme.js";
import DuckDanceApp from "./DuckDanceApp.jsx";

// Build tag: bump to change the bundle's content hash, e.g. to bust a stale
// edge-cached asset URL on the HF Space.
const BUILD_TAG = "2026-08-25";
console.info(`Microduck build ${BUILD_TAG}`);
console.info("DuckDance: video-driven choreography for the Microduck sandbox");

// No StrictMode: the game core is a heavyweight singleton (MuJoCo WASM,
// ONNX sessions, WebRTC room) and dev double-mounting would double-boot it.
createRoot(document.getElementById("root")).render(
  <ThemeProvider theme={theme}>
    <CssBaseline />
    <DuckDanceApp />
  </ThemeProvider>,
);
