// Split shell: the dance lab on the left, the untouched sandbox on the
// right.
//
// The sandbox is a full-screen game. Its canvas, HUD, BIOS readout, title
// menu and preboot veil are all `position: fixed`, which normally means
// "relative to the viewport" and would have them cover the lab. Rather
// than rewrite every one of those layers, the right-hand pane is given a
// transform, which makes it the containing block for fixed descendants.
// The sandbox then lays itself out inside the pane and needs no changes
// at all -- and stays that way when the upstream Space moves on.

import { useEffect, useState } from "react";
import Box from "@mui/material/Box";
import App from "./App.jsx";
import DanceLab from "./dance/ui/DanceLab.jsx";
import { COMIC_INK } from "./ui/comic.jsx";

// Below this the two panes stack instead of sitting side by side.
const STACK_AT = 900;

export default function DuckDanceApp() {
  const [narrow, setNarrow] = useState(
    typeof window !== "undefined" && window.innerWidth < STACK_AT,
  );

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${STACK_AT - 1}px)`);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  return (
    <Box
      sx={{
        position: "fixed", inset: 0, display: "flex",
        flexDirection: narrow ? "column" : "row",
        background: COMIC_INK,
      }}
    >
      <Box
        sx={{
          flex: narrow ? "0 0 auto" : "0 0 clamp(360px, 34vw, 520px)",
          height: narrow ? "58%" : "100%",
          minHeight: 0,
          borderRight: narrow ? "none" : "2px solid rgba(255,255,255,0.12)",
          borderBottom: narrow ? "2px solid rgba(255,255,255,0.12)" : "none",
          background: "#0a0a10",
        }}
      >
        <DanceLab />
      </Box>
      <Box
        sx={{
          position: "relative", flex: "1 1 auto", minWidth: 0, minHeight: 0,
          overflow: "hidden",
          // The line that scopes the sandbox's fixed layers to this pane.
          transform: "translateZ(0)",
        }}
      >
        <App />
      </Box>
    </Box>
  );
}
