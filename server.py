#!/usr/bin/env python3
"""
Soundscape Loop Creator — Development Server

Serves static files and proxies Freesound audio CDN requests (which lack CORS headers).

Usage:
    python3 server.py
    # Open http://localhost:8000/soundscape.html
"""

import http.server
import urllib.request
import urllib.parse
import sys

PORT = 8000

ALLOWED_HOSTS = [
    'freesound.org',
    'cdn.freesound.org',
    'freesound-api.s3.amazonaws.com',
]


class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/proxy?'):
            self.handle_proxy()
        else:
            super().do_GET()

    def handle_proxy(self):
        query = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(query)
        url = params.get('url', [None])[0]

        if not url:
            self.send_error(400, 'Missing url parameter')
            return

        # Validate the target host
        parsed = urllib.parse.urlparse(url)
        if not any(parsed.hostname and parsed.hostname.endswith(host) for host in ALLOWED_HOSTS):
            self.send_error(403, 'Host not allowed')
            return

        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': 'SoundscapeLoopCreator/1.0',
            })
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
                content_type = resp.headers.get('Content-Type', 'application/octet-stream')

            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', len(data))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'public, max-age=86400')
            self.end_headers()
            self.wfile.write(data)

        except urllib.error.HTTPError as e:
            self.send_error(e.code, str(e.reason))
        except Exception as e:
            self.send_error(502, f'Proxy error: {e}')

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.end_headers()

    def end_headers(self):
        # Add CORS to all responses
        if not any(k == 'Access-Control-Allow-Origin' for k, v in self._headers_buffer_list()):
            self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def _headers_buffer_list(self):
        """Parse already-buffered headers to avoid duplicates."""
        headers = []
        for line in self._headers_buffer:
            if isinstance(line, bytes):
                line = line.decode('latin-1')
            if ':' in line:
                k, v = line.split(':', 1)
                headers.append((k.strip(), v.strip()))
        return headers


if __name__ == '__main__':
    handler = ProxyHandler
    with http.server.HTTPServer(('', PORT), handler) as httpd:
        print(f'Soundscape server running at http://localhost:{PORT}/')
        print(f'Open http://localhost:{PORT}/soundscape.html')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nShutting down.')
            sys.exit(0)
