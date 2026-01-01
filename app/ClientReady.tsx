"use client";

import { useEffect } from "react";
import { sdk } from "@farcaster/miniapp-sdk";

export default function ClientReady() {
  useEffect(() => {
    // For games, disabling native gestures prevents accidental swipe-to-dismiss.
    sdk.actions.ready({ disableNativeGestures: true }).catch(() => {});
  }, []);
  return null;
}
