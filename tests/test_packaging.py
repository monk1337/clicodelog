"""Guards the packaging bug that shipped in every release.

`package-data` declared "static/js/*.js", which setuptools does not expand
recursively, so clicodelog/static/js/vendor/ was excluded from every wheel.
Users who installed from PyPI got no marked, no DOMPurify and no highlight.js;
renderMarkdownInto falls back to textContent, so markdown rendered as raw
source with no error anywhere. The editable dev install worked fine, which is
why it went unnoticed.
"""

import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
VENDOR = ["marked.min.js", "purify.min.js", "highlight.min.js"]


@pytest.fixture(scope="module")
def wheel(tmp_path_factory):
    out = tmp_path_factory.mktemp("dist")
    try:
        subprocess.run(
            [sys.executable, "-m", "build", "--wheel", "--outdir", str(out)],
            cwd=REPO, check=True, capture_output=True, timeout=600,
        )
    except FileNotFoundError:
        pytest.skip("build module not available")
    except subprocess.CalledProcessError as e:
        pytest.fail(f"wheel build failed:\n{e.stderr.decode()[-2000:]}")
    wheels = list(out.glob("*.whl"))
    assert wheels, "no wheel produced"
    return wheels[0]


def test_vendor_js_is_packaged(wheel):
    names = zipfile.ZipFile(wheel).namelist()
    for lib in VENDOR:
        assert any(n.endswith(f"static/js/vendor/{lib}") for n in names), (
            f"{lib} missing from the wheel — markdown rendering and syntax "
            f"highlighting silently break for every pip install"
        )


def test_templates_and_css_are_packaged(wheel):
    names = zipfile.ZipFile(wheel).namelist()
    assert any(n.endswith("templates/index.html") for n in names)
    assert any(n.endswith("templates/view.html") for n in names)
    assert any(n.endswith("static/css/base.css") for n in names)


def test_every_referenced_static_file_is_packaged(wheel):
    """Anything a template <script>/<link>s must actually be in the wheel."""
    import re

    names = set(zipfile.ZipFile(wheel).namelist())
    referenced = set()
    for tpl in (REPO / "clicodelog" / "templates").glob("*.html"):
        text = tpl.read_text()
        referenced |= set(re.findall(r'(?:src|href)="/static/([^"?]+)', text))

    missing = [
        ref for ref in referenced
        if not any(n.endswith(f"clicodelog/static/{ref}") for n in names)
    ]
    assert not missing, f"templates reference files absent from the wheel: {missing}"


def test_every_bundled_file_is_packaged(wheel):
    """Pages load bundles assembled from these files at request time; a file
    missing from the wheel would make every page 500 on a pip install."""
    from clicodelog.assets import BUNDLES

    names = set(zipfile.ZipFile(wheel).namelist())
    missing = [
        f for files in BUNDLES.values() for f in files
        if not any(n.endswith(f"clicodelog/static/{f}") for n in names)
    ]
    assert not missing, f"bundled files absent from the wheel: {missing}"
    for partial in ("_icons.html", "_conversation.html", "_dialogs.html"):
        assert any(n.endswith(f"templates/{partial}") for n in names), partial
