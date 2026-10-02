import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from analyze import complaint_analysis, summary_analysis, trend_analysis


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/ai/health':
            self.respond(200, {'ok': True})
        else:
            self.respond(404, {'error': 'Not found'})

    def do_POST(self):
        if self.path != '/ai/analyze':
            return self.respond(404, {'error': 'Not found'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            data = json.loads(self.rfile.read(length))
            mode = data.get('mode')
            result = trend_analysis(data) if mode == 'trends' else summary_analysis(data) if mode == 'summaries' else complaint_analysis(data)
            self.respond(200, result)
        except (ValueError, TypeError, json.JSONDecodeError):
            self.respond(400, {'error': 'Invalid AI input'})
        except Exception:
            self.respond(500, {'error': 'AI analysis failed'})

    def respond(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        return


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', 8000), Handler).serve_forever()
