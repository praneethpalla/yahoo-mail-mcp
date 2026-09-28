<#
.SYNOPSIS
    Store or read the Yahoo app password in Windows Credential Manager (a "Generic" credential).

.DESCRIPTION
    Uses the Windows CredWrite/CredRead APIs directly, so no extra PowerShell modules are needed.

    Store it once (you'll be prompted for the password; input is hidden):
        powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows-credential.ps1 -Set -User you@yahoo.com

    Then in .env:
        YAHOO_APP_PASSWORD_COMMAND=powershell -NoProfile -ExecutionPolicy Bypass -File C:\path\to\yahoo-mail-mcp\scripts\windows-credential.ps1

    Note: Credential Manager doesn't ask for approval on each read; any program running as your
    Windows user can read the credential. It is encrypted by Windows and kept out of project files.

.PARAMETER Target
    Credential name in Credential Manager (default: yahoo-mail-mcp).

.PARAMETER Set
    Store (or replace) the password instead of printing it.

.PARAMETER User
    The Yahoo email address saved with the credential (used with -Set).
#>
param(
    [string]$Target = 'yahoo-mail-mcp',
    [switch]$Set,
    [string]$User = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class YahooMcpCred {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDENTIAL {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    private const int CRED_TYPE_GENERIC = 1;
    private const int CRED_PERSIST_LOCAL_MACHINE = 2;

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWriteW(ref CREDENTIAL credential, int flags);

    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr buffer);

    public static string Read(string target) {
        IntPtr ptr;
        if (!CredReadW(target, CRED_TYPE_GENERIC, 0, out ptr)) {
            throw new Exception("No credential named '" + target + "' in Windows Credential Manager (error " + Marshal.GetLastWin32Error() + ")");
        }
        try {
            CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
            if (cred.CredentialBlobSize == 0) return "";
            return Marshal.PtrToStringUni(cred.CredentialBlob, cred.CredentialBlobSize / 2);
        } finally {
            CredFree(ptr);
        }
    }

    public static void Write(string target, string user, string secret) {
        byte[] bytes = System.Text.Encoding.Unicode.GetBytes(secret);
        IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
        try {
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            CREDENTIAL cred = new CREDENTIAL();
            cred.Type = CRED_TYPE_GENERIC;
            cred.TargetName = target;
            cred.UserName = user;
            cred.CredentialBlob = blob;
            cred.CredentialBlobSize = bytes.Length;
            cred.Persist = CRED_PERSIST_LOCAL_MACHINE;
            if (!CredWriteW(ref cred, 0)) {
                throw new Exception("Could not save the credential (error " + Marshal.GetLastWin32Error() + ")");
            }
        } finally {
            for (int i = 0; i < bytes.Length; i++) { Marshal.WriteByte(blob, i, 0); }
            Marshal.FreeHGlobal(blob);
        }
    }
}
'@

if ($Set) {
    $secure = Read-Host -AsSecureString "App password for '$Target'"
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        if ([string]::IsNullOrEmpty($plain)) { throw 'The password cannot be empty.' }
        [YahooMcpCred]::Write($Target, $User, $plain)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    Write-Host "Saved '$Target' in Windows Credential Manager."
} else {
    # Print only the password, with no trailing newline, for YAHOO_APP_PASSWORD_COMMAND
    [Console]::Out.Write([YahooMcpCred]::Read($Target))
}
