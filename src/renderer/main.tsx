import { createRoot } from "react-dom/client";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import { App } from "./App";
import { PairScreen, createRemoteHub, isWeb } from "./remote";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
if (isWeb) {
  // Phone: same app, carried over Happy's remote connection. Unpaired devices see the pairing screen.
  document.documentElement.classList.add("web");
  const showPair = () => root.render(<PairScreen />);
  (window as { hub?: unknown }).hub = createRemoteHub(showPair, (up) => document.documentElement.classList.toggle("offline", !up));
  fetch("/api/me")
    .then((r) => r.json())
    .then((me) => (me.paired ? root.render(<App />) : showPair()))
    .catch(showPair);
} else {
  root.render(<App />);
}
