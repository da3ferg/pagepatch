import { useState } from "react";
import { Hero } from "./components/Hero";
import { Pricing } from "./components/Pricing";

export function App() {
  const [version, setVersion] = useState(0);
  return (
    <main>
      <Hero />
      {/* key change forces React to replace the pricing section (used to test stale selections) */}
      <Pricing key={version} />
      <button className="rerender" onClick={() => setVersion((v) => v + 1)}>Refresh plans</button>
    </main>
  );
}
