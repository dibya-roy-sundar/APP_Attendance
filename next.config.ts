import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // A cached service worker is the classic PWA trap: a stale one keeps
        // serving an old shell long after a deploy. Always revalidate.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
      {
        // Served as octet-stream otherwise, which some browsers refuse to
        // treat as a manifest.
        source: '/manifest.webmanifest',
        headers: [{ key: 'Content-Type', value: 'application/manifest+json' }],
      },
    ];
  },
};

export default nextConfig;
