"""
CLI Code Log - Browse, inspect, and export logs from CLI-based AI coding agents.
"""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("clicodelog")
except PackageNotFoundError:
    __version__ = "0.2.3"

__author__ = "monk1337"
