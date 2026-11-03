"""MaiHub API client: Civitai 资源解析 (model civitai-inspect) and the work's saved images / video frames."""
import json
import re

import aiohttp

ASSET = re.compile(r"maihub-asset:([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})")
IMAGE_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}


class MaiHubError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def _auth(settings):
    if not settings.get("maihub_token"):
        raise MaiHubError("请先在 Civitai 填充的设置里填写 MaiHub API Token（MaiHub 网页「API Token」页创建）", 400)
    return {"Authorization": "Bearer " + settings["maihub_token"]}


async def inspect(settings, url, session=None):
    """The 资源解析 report for a Civitai image / video page (docs/RULES.md · report)."""
    if not isinstance(url, str) or not re.match(r"^https://(www\.)?civitai\.(com|red)/images/\d+", url.strip()):
        raise MaiHubError("请填写 Civitai 作品地址，例如 https://civitai.com/images/123456", 400)
    owned = session is None
    session = session or aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=300))
    try:
        async with session.post(settings["maihub_url"] + "/api/infer", headers=_auth(settings),
                                json={"model": "civitai-inspect", "providerId": "maihub", "input": {"url": url.strip()}}) as response:
            body = await response.json(content_type=None)
            if response.status != 200:
                raise MaiHubError((body or {}).get("error") or f"MaiHub 返回 HTTP {response.status}", response.status)
            if body.get("status") != "succeeded" or not isinstance(body.get("output"), str):
                raise MaiHubError(body.get("error") or "MaiHub 未返回解析结果")
            return json.loads(body["output"])
    except aiohttp.ClientError as error:
        raise MaiHubError(f"无法连接 MaiHub：{error}") from None
    finally:
        if owned:
            await session.close()


async def asset(settings, reference, session=None):
    """(bytes, extension) of a MaiHub asset the token's user owns, e.g. a work image saved by 资源解析."""
    match = ASSET.fullmatch(reference or "")
    if not match:
        raise MaiHubError("图片引用无效", 400)
    owned = session is None
    session = session or aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=120))
    try:
        async with session.get(f"{settings['maihub_url']}/api/assets/{match.group(1)}", headers=_auth(settings)) as response:
            if response.status != 200:
                raise MaiHubError(f"MaiHub 图片下载失败（HTTP {response.status}）", response.status)
            extension = IMAGE_TYPES.get(response.headers.get("Content-Type", "").split(";")[0].strip())
            if not extension:
                raise MaiHubError("MaiHub 返回的不是图片")
            return await response.read(), extension
    except aiohttp.ClientError as error:
        raise MaiHubError(f"无法连接 MaiHub：{error}") from None
    finally:
        if owned:
            await session.close()
