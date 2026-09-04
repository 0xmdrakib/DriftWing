import "./globals.css";
import type { Metadata, Viewport } from "next";
import ClientReady from "./ClientReady";

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://driftwing.vercel.app/");


const BASE_APP_ID = "695832f84d3a403912ed8a9c";

const ASSET_V = process.env.NEXT_PUBLIC_ASSET_VERSION || "2";


export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: "Drift Wing",
  description: "A tiny arcade shooter on Base — every run gets saved onchain.",
  other: {
    // ✅ Base App ownership verification tag (must be in <head>)
    "base:app_id": BASE_APP_ID,
  },
  openGraph: {
    title: "DriftWing",
    description: "Move, shoot, survive. Every score is written onchain (Base).",
    url: APP_URL,
    siteName: "Drift Wing",
    images: [
      {
        url: `/hero.png?v=${ASSET_V}`,
        width: 1200,
        height: 630,
        alt: "Drift Wing",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Drift Wing",
    description: "Move, shoot, survive. Every score is written onchain (Base).",
    images: [`/hero.png?v=${ASSET_V}`],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0b0f14",
};

import { Balsamiq_Sans } from "next/font/google";
const balsamiq = Balsamiq_Sans({ weight: ["400", "700"], subsets: ["latin"] });

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={balsamiq.className}>
        <ClientReady />
        {children}
      </body>
    </html>
  );
}
