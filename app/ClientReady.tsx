"use client";

import { useEffect } from "react";

export default function ClientReady() {
  useEffect(() => {
    // Keep a stable "app height" across mobile WebViews where 100vh/100dvh can be wrong.
    // We use the *visible* viewport height (innerHeight) and expose it as a CSS variable.
    const setAppHeight = () => {
      document.documentElement.style.setProperty("--app-height", `${window.innerHeight}px`);
    };

    setAppHeight();
    const raf = requestAnimationFrame(setAppHeight);

    window.addEventListener("resize", setAppHeight);
    window.addEventListener("orientationchange", setAppHeight);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", setAppHeight);
      window.removeEventListener("orientationchange", setAppHeight);
    };
  }, []);

  return null;
}
