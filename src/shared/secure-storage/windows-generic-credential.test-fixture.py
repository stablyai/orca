"""Owned disposable-item setup for the Windows native replacement contract."""
import ctypes
import sys
from ctypes import wintypes

phase, target = sys.argv[1:]
assert target.startswith('orca-sta11846-test:') and target != 'gemini:antigravity'

class Attribute(ctypes.Structure):
    _fields_ = [('Keyword', wintypes.LPWSTR), ('Flags', wintypes.DWORD),
                ('ValueSize', wintypes.DWORD), ('Value', ctypes.POINTER(ctypes.c_ubyte))]

class Credential(ctypes.Structure):
    _fields_ = [('Flags', wintypes.DWORD), ('Type', wintypes.DWORD),
                ('TargetName', wintypes.LPWSTR), ('Comment', wintypes.LPWSTR),
                ('LastWritten', wintypes.FILETIME), ('CredentialBlobSize', wintypes.DWORD),
                ('CredentialBlob', ctypes.POINTER(ctypes.c_ubyte)), ('Persist', wintypes.DWORD),
                ('AttributeCount', wintypes.DWORD), ('Attributes', ctypes.POINTER(Attribute)),
                ('TargetAlias', wintypes.LPWSTR), ('UserName', wintypes.LPWSTR)]

api = ctypes.WinDLL('advapi32', use_last_error=True)
api.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                         ctypes.POINTER(ctypes.POINTER(Credential))]
api.CredReadW.restype = wintypes.BOOL
api.CredWriteW.argtypes = [ctypes.POINTER(Credential), wintypes.DWORD]
api.CredWriteW.restype = wintypes.BOOL
api.CredFree.argtypes = [ctypes.c_void_p]

if phase == 'seed':
    prior = ctypes.POINTER(Credential)()
    assert not api.CredReadW(target, 1, 0, ctypes.byref(prior))
    assert ctypes.get_last_error() == 1168
    blob = (ctypes.c_ubyte * 7)(*b'initial')
    value = (ctypes.c_ubyte * 3)(1, 2, 3)
    attributes = (Attribute * 1)(Attribute('orca-fixture', 0, 3, value))
    credential = Credential(0, 1, target, 'fixture-comment', wintypes.FILETIME(),
                            7, blob, 1, 1, attributes, 'fixture-alias', 'fixture-user')
    assert api.CredWriteW(ctypes.byref(credential), 0), ctypes.get_last_error()
elif phase == 'verify':
    raw = ctypes.POINTER(Credential)()
    assert api.CredReadW(target, 1, 0, ctypes.byref(raw)), ctypes.get_last_error()
    try:
        credential = raw.contents
        assert (credential.Type, credential.Flags, credential.Persist) == (1, 0, 1)
        assert (credential.UserName, credential.Comment, credential.TargetAlias) == (
            'fixture-user', 'fixture-comment', 'fixture-alias')
        assert credential.AttributeCount == 1
        attribute = credential.Attributes[0]
        assert (attribute.Keyword, attribute.Flags) == ('orca-fixture', 0)
        assert ctypes.string_at(attribute.Value, attribute.ValueSize) == bytes([1, 2, 3])
        assert ctypes.string_at(credential.CredentialBlob, credential.CredentialBlobSize) == b'replacement-fixture'
    finally:
        api.CredFree(raw)
else:
    raise AssertionError('unknown fixture phase')
