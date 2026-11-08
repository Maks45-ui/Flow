"""Allow only Flow's root iframe navigation; retain ComfyUI's API/CSRF checks."""
import logging
import os
from urllib.parse import urlsplit

from aiohttp import web

NODE_CLASS_MAPPINGS = {}


def origin(value):
    try:
        url = urlsplit(value)
        if url.scheme != "http" or url.hostname not in ("tauri.localhost", "localhost", "127.0.0.1"):
            return None
        if url.username is not None or url.password is not None:
            return None
        return (url.scheme, url.hostname, url.port or 80)
    except ValueError:
        return None


def flow_navigation(request, allowed_origin):
    """No API, websocket, upload, arbitrary website or opaque-origin exception."""
    return (
        allowed_origin is not None
        and request.method in ("GET", "HEAD")
        and request.path == "/"
        and request.headers.get("Sec-Fetch-Site") == "cross-site"
        and request.headers.get("Sec-Fetch-Dest") == "iframe"
        and request.headers.get("Sec-Fetch-Mode") == "navigate"
        and origin(request.headers.get("Referer", "")) == allowed_origin
        and ("Origin" not in request.headers or origin(request.headers["Origin"]) == allowed_origin)
    )


def install(app, allowed_origin):
    if allowed_origin is None:
        return False
    for index, middleware in enumerate(app.middlewares):
        if getattr(middleware, "__name__", "") == "flow_origin_only_middleware":
            return True
        if getattr(middleware, "__name__", "") != "origin_only_middleware":
            continue

        @web.middleware
        async def flow_origin_only_middleware(request, handler, original=middleware):
            if flow_navigation(request, allowed_origin):
                return await handler(request)
            return await original(request, handler)

        app.middlewares[index] = flow_origin_only_middleware
        logging.info("[Flow] Embedded ComfyUI enabled; cross-site API protection retained.")
        return True
    logging.warning("[Flow] ComfyUI origin middleware not found; embedding exception was not installed.")
    return False


# ComfyUI creates PromptServer before loading custom_nodes and before freezing its app.
from server import PromptServer
install(PromptServer.instance.app, origin(os.environ.get("FLOW_COMFY_EMBED_ORIGIN", "")))
