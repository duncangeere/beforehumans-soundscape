#!/usr/bin/env python3
"""
Soundscape Loop Creator — Development Server

Serves this folder's static files and proxies Freesound audio and waveform
images, whose CDN lacks the CORS headers the page needs to read them.

Usage:
    python3 server.py
    # Open http://localhost:8000/

Security notes:
- Listens on 127.0.0.1 only, so other machines on the same network
  (café wifi, say) can't reach it.
- Sends no CORS headers. The page calls /proxy on the same origin, so it
  doesn't need them, and leaving them out stops other websites open in your
  browser from reading what this server returns.
- The proxy only fetches https URLs on Freesound's own domains, and checks
  every redirect against the same rule, so it can't be pointed at other
  sites or at devices on your local network.
"""

import http.server
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from functools import partial

HOST = '127.0.0.1'
PORT = 8000

# Serve files from the folder this script lives in, whichever directory it
# was started from, so running it from elsewhere can't expose other files.
SITE_DIR = os.path.dirname(os.path.abspath(__file__))

# Domains the proxy may fetch from. A URL's hostname must be one of these
# exactly, or a subdomain of one (so 'cdn.freesound.org' is allowed, but
# 'notfreesound.org' and 'freesound.org.example.com' are not).
ALLOWED_HOSTS = (
    'freesound.org',
    'freesound-api.s3.amazonaws.com',
)

# Upper limit on a proxied response, so a misbehaving upstream can't exhaust
# memory. Freesound previews and waveform images are far smaller than this.
MAX_PROXY_BYTES = 50 * 1024 * 1024

PROXY_TIMEOUT_SECONDS = 30


def is_allowed_url(url):
    """True if the proxy may fetch this URL: https, and an allowed host."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != 'https' or not parsed.hostname:
        return False
    hostname = parsed.hostname.lower()
    return any(hostname == host or hostname.endswith('.' + host)
               for host in ALLOWED_HOSTS)


class CheckedRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Follow a redirect only if its target also passes is_allowed_url.

    Without this, an allowed URL could redirect the proxy anywhere,
    including to addresses on your local network.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not is_allowed_url(newurl):
            raise urllib.error.HTTPError(
                newurl, 403, 'Redirect to a host that is not allowed',
                headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


# One opener for all proxy requests, using the redirect check above.
proxy_opener = urllib.request.build_opener(CheckedRedirectHandler)


class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/proxy?'):
            self.handle_proxy()
        else:
            super().do_GET()

    def handle_proxy(self):
        query = urllib.parse.urlparse(self.path).query
        url = urllib.parse.parse_qs(query).get('url', [None])[0]

        if not url:
            self.send_error(400, 'Missing url parameter')
            return

        if not is_allowed_url(url):
            self.send_error(403, 'Host not allowed')
            return

        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': 'SoundscapeLoopCreator/1.0',
            })
            with proxy_opener.open(req, timeout=PROXY_TIMEOUT_SECONDS) as resp:
                # Read one byte past the limit so an oversized response can
                # be detected without reading the whole thing.
                data = resp.read(MAX_PROXY_BYTES + 1)
                content_type = resp.headers.get(
                    'Content-Type', 'application/octet-stream')

            if len(data) > MAX_PROXY_BYTES:
                self.send_error(502, 'Upstream response too large')
                return

            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'public, max-age=86400')
            self.end_headers()
            self.wfile.write(data)

        except urllib.error.HTTPError as e:
            self.send_error(e.code, str(e.reason))
        except Exception as e:
            self.send_error(502, f'Proxy error: {e}')


if __name__ == '__main__':
    handler = partial(ProxyHandler, directory=SITE_DIR)
    with http.server.HTTPServer((HOST, PORT), handler) as httpd:
        print(f'Soundscape server running at http://localhost:{PORT}/')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nShutting down.')
            sys.exit(0)
