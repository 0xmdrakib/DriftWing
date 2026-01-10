"use client";
import { useEffect, useState } from "react";

export default function FirstRunPrompt() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const key = "dw:first-run";
    if (!localStorage.getItem(key)) {
      setShow(true);
      localStorage.setItem(key, "1");
    }
  }, []);

  if (!show) return null;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://driftwing.vercel.app";
  const warpcastAdd = `https://warpcast.com/~/add-miniapp?url=${encodeURIComponent(appUrl)}`;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-[#0f1012] p-5 shadow-xl">
        <h3 className="text-white text-lg font-semibold mb-2">Add DriftWing</h3>
        <p className="text-white/70 text-sm mb-4">
          Add this mini app and enable notifications to get reminders and score updates.
        </p>

        <div className="space-y-2">
          <a href={warpcastAdd} className="block w-full text-center rounded-xl bg-white text-black py-2 font-medium">
            Add on Warpcast
          </a>
          <button
            onClick={() => setShow(false)}
            className="w-full rounded-xl border border-white/15 text-white py-2"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
