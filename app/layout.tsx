import "./globals.css";
import type { Metadata, Viewport } from "next";
import ClientReady from "./ClientReady";

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: "DriftWing",
  description: "A tiny arcade shooter on Base — every run gets saved onchain.",
  other: {
    // Mini App embed metadata (the launch button + preview).
    // Base + Farcaster both support `fc:miniapp`. Keeping a `fc:frame` fallback
    // helps older clients.
    "fc:miniapp": JSON.stringify({
      version: "1",
      imageUrl: `${APP_URL}/hero.png`,
      button: {
        title: "Play DriftWing",
        action: {
          type: "launch_miniapp",
          name: "DriftWing",
          url: APP_URL,
          splashImageUrl: `${APP_URL}/splash.png`,
          splashBackgroundColor: "#070A12",
        },
      },
    }),
    "fc:frame": JSON.stringify({
      version: "1",
      imageUrl: `${APP_URL}/hero.png`,
      button: {
        title: "Play DriftWing",
        action: {
          type: "launch_frame",
          name: "DriftWing",
          url: APP_URL,
          splashImageUrl: `${APP_URL}/splash.png`,
          splashBackgroundColor: "#070A12",
        },
      },
    }),
  },
  openGraph: {
    title: "DriftWing",
    description: "Move, shoot, survive. Every score is written onchain (Base).",
    url: APP_URL,
    siteName: "DriftWing",
    images: [
      {
        url: "/hero.png",
        width: 1200,
        height: 800,
        alt: "DriftWing",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "DriftWing",
    description: "Move, shoot, survive. Every score is written onchain (Base).",
    images: ["/hero.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0b0f14",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <ClientReady />
        {children}
      </body>
    </html>
  );
}
