import http.server
import os
import socketserver
import sys

PORT = 3000
DIRECTORY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "extension")


class ThreadedTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


class ExtensionDevHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self.send_response(302)
            self.send_header("Location", "/popup/popup.html")
            self.end_headers()
            return
        if self.path in ("/favicon.ico", "/favicon.png"):
            icon_path = os.path.join(DIRECTORY, "icons", "icon-32.png")
            if os.path.exists(icon_path):
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.end_headers()
                with open(icon_path, "rb") as f:
                    self.wfile.write(f.read())
                return
        super().do_GET()

    def guess_type(self, path):
        for ext, mime in (
            (".js", "application/javascript"),
            (".json", "application/json"),
            (".css", "text/css"),
            (".html", "text/html"),
        ):
            if path.endswith(ext):
                return mime
        return super().guess_type(path)


def run():
    with ThreadedTCPServer(("127.0.0.1", PORT), ExtensionDevHandler) as httpd:
        print(f"\nTheme Studio -> http://127.0.0.1:{PORT}/popup/popup.html\n")
        sys.stdout.flush()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down dev server.")


if __name__ == "__main__":
    run()
