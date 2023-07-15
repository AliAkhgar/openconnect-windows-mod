// vpnc-script-win.js
//
// Originally part of vpnc source code:
// © 2007-2008 Maurice Massar, Jörg Mayer, Antonio Borneo, et al.
// © 2014 David Woodhouse <dwmw2@infradead.org>
// © 2020-2022 Daniel Lenski <dlenski@gmail.com> et al.
//
// Routing, IP, and DNS configuration script for OpenConnect.
//
// Microsoft's "JScript" is what we're actually using here.  It's
// based on a truly ancient version of JavaScript (ECMAScript 3.0
// according to a Microsoft engineer, see
// https://stackoverflow.com/a/28331933) so it doesn't include any
// modern features:
//   - no String.prototype.trim       (ECMAScript 5.0)
//   - no Date.prototype.toISOString  (ECMAScript 5.1)
//   - no 'const'                     (ECMAScript 6.0)

// --------------------------------------------------------------
// Initial setup
// --------------------------------------------------------------

var accumulatedExitCode = 0;
var ws = WScript.CreateObject("WScript.Shell");
var env = ws.Environment("Process");
var comspec = ws.ExpandEnvironmentStrings("%comspec%");

var ERROR = 0, INFO = 1, DEBUG = 2, TRACE = 3;
var logLevel = parseInt(env("LOG_LEVEL")) || INFO;
var logTimestamps = false;

// How to add the default internal route
// 0 - As interface gateway when setting properties
// 1 - As a 0.0.0.0/0 route with a lower metric than the default route
// 2 - As 0.0.0.0/1 + 128.0.0.0/1 routes (override the default route cleanly)
var REDIRECT_GATEWAY_METHOD = 0;

// --------------------------------------------------------------
// Utilities
// --------------------------------------------------------------

function ocTimestamp(d) {
    // Matches format of `openconnect --timestamp` ("%Y-%m-%d %H:%M:%S", local time)
    function pad(number) {
        if (number < 10)
            return '0' + number;
        return number;
    }
    return (d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' '
            + pad(d.getHours()) + ':' + pad(d.getMinutes())   + ':' + pad(d.getSeconds()));
}

function echo(level, msg)
{
    if (logLevel < level)
        return;

    if (logTimestamps)
        WScript.echo("[" + ocTimestamp(new Date()) + "] " + msg);
    else
        WScript.echo(msg);
}

function run(cmd)
{
    var fullCmd = comspec + " /C \"" + cmd + "\" 2>&1";
    echo(DEBUG, "-> " + fullCmd);
    var oExec = ws.Exec(fullCmd);
    oExec.StdIn.Close();

    var s = oExec.StdOut.ReadAll();

    var exitCode = oExec.ExitCode;
    if (exitCode != 0)
        echo(ERROR, "\"" + cmd + "\" returned non-zero exit status: " + exitCode);
    echo((exitCode != 0 ? ERROR : TRACE), "   stdout+stderr dump: " + s);
    accumulatedExitCode += exitCode;

    return s;
}

function getDefaultGateway()
{
    if (run("route print").match(/0\.0\.0\.0 *(0|128)\.0\.0\.0 *([0-9\.]*)/)) {
        return (RegExp.$2);
    }
    return ("");
}

if (!String.prototype.trim) {
    String.prototype.trim = function () {
        return this.replace(/^[\s\uFEFF\xA0]+|[\s\uFEFF\xA0]+$/g, '');
    };
}

// --------------------------------------------------------------
// Script starts here
// --------------------------------------------------------------

switch (env("reason")) {
case "pre-init":
    break;
case "connect":
    var gw = getDefaultGateway();

    var winVer = null;
    if (run("ver").match(/version\s+((\d+\.)+\d+)/i)) {
        winVer = RegExp.$1;
        echo(INFO, "Running on Windows version: " + winVer);
    } else
        echo(ERROR, "Could not determine Windows version from 'ver' command");

    // Use INTERNAL_IP4_ADDRESS as the "gateway" address for the
    // VPN tunnel connection. As noted in the OpenConnect source,
    // "It's a tunnel; having a gateway is meaningless." Setting
    // the gateway to match the INTERNAL_IP4_ADDRESS seems like
    // the simplest way to behave correctly in all cases,
    // including when the INTERNAL_IP4_NETMASK is /0 or /32.
    var internal_ip4_netmask = env("INTERNAL_IP4_NETMASK") || "255.255.255.255";
    var internal_gw = env("INTERNAL_IP4_ADDRESS");

    echo(INFO, "Default/Internet gateway  : " + gw);
    echo(INFO, "VPN Interface Identifiers : \"" + env("TUNDEV") + "\" / " + env("TUNIDX"));
    echo(INFO, "Public VPN Gateway Address: " + env("VPNGATEWAY"));
    echo(INFO, "Internal Legacy IP Address: " + env("INTERNAL_IP4_ADDRESS"));
    echo(INFO, "Internal Legacy IP Netmask: " + internal_ip4_netmask);


    if (env("INTERNAL_IP4_MTU")) {
        echo(INFO, "MTU: " + env("INTERNAL_IP4_MTU"));
        run("netsh interface ipv4 set subinterface " + env("TUNIDX") +
            " mtu=" + env("INTERNAL_IP4_MTU") + " store=active");

        if (env("INTERNAL_IP6_ADDRESS")) {
            run("netsh interface ipv6 set subinterface " + env("TUNIDX") +
                " mtu=" + env("INTERNAL_IP4_MTU") + " store=active");
        }
    }

    // Add explicit route for the VPN gateway to avoid routing loops
    // FIXME: handle IPv6 gateway address
    echo(INFO, "Configuring explicit route to VPN gateway " + env("VPNGATEWAY"));
    run("route add " + env("VPNGATEWAY") + " mask 255.255.255.255 " + gw);
    echo(INFO, "done.");

    echo(INFO, "Configuring \"" + env("TUNDEV") + "\" / " + env("TUNIDX") + " interface for Legacy IP...");

    if (!env("CISCO_SPLIT_INC") && REDIRECT_GATEWAY_METHOD != 2) {
        // Interface metric must be set to 1 in order to add a route with metric 1 since Windows Vista
        run("netsh interface ip set interface " + env("TUNIDX") + " metric=1 store=active");
    }

    if (env("CISCO_SPLIT_INC") || REDIRECT_GATEWAY_METHOD > 0) {
        run("netsh interface ip set address " + env("TUNIDX") + " static " +
            env("INTERNAL_IP4_ADDRESS") + " " + internal_ip4_netmask + " store=active");
    } else {
        // The default route will be added automatically
        run("netsh interface ip set address " + env("TUNIDX") + " static " +
            env("INTERNAL_IP4_ADDRESS") + " " + internal_ip4_netmask + " " + internal_gw +
            " gwmetric=1 store=active");
    }

    run("netsh interface ipv4 del wins " + env("TUNIDX") + " all");
    if (env("INTERNAL_IP4_NBNS")) {
        var wins = env("INTERNAL_IP4_NBNS").split(/ /);
        for (var i = 0; i < wins.length; i++) {
            run("netsh interface ipv4 add wins " + env("TUNIDX") + " " + wins[i]);
        }
        echo(INFO, "Configured " + wins.length + " WINS servers: " + wins.join(" "));
    }

    run("netsh interface ipv4 del dns " + env("TUNIDX") + " all");
    run("netsh interface ipv6 del dns " + env("TUNIDX") + " all");
    if (env("INTERNAL_IP4_DNS")) {
        var dns = env("INTERNAL_IP4_DNS").split(/ /);
        for (var i = 0; i < dns.length; i++) {
            var protocol = dns[i].indexOf(":") !== -1 ? "ipv6" : "ipv4";
            // With 'validate=yes' (the default on newer Windows versions), Windows will try to
            // connect to the DNS server, time out after ~10 seconds, and print a warning, but
            // nevertheless add the specified server. Adding 'validate=no' is thus necessary.
            // FIXME: determine the earliest Windows version that actually requires this flag.
            run("netsh interface " + protocol + " add dns " + env("TUNIDX") + " " + dns[i]
                + (winVer >= "10." ? " validate=no" : ""));
        }
        echo(INFO, "Configured " + dns.length + " DNS servers: " + dns.join(" "));
    }
    echo(INFO, "done.");

    // Add internal network routes
    echo(INFO, "Configuring Legacy IP networks:");
    if (env("CISCO_SPLIT_INC")) {
        for (var i = 0 ; i < parseInt(env("CISCO_SPLIT_INC")); i++) {
            var network = env("CISCO_SPLIT_INC_" + i + "_ADDR");
            var netmask = env("CISCO_SPLIT_INC_" + i + "_MASK");
            var netmasklen = env("CISCO_SPLIT_INC_" + i + "_MASKLEN");
            run("route add " + network + " mask " + netmask +
                " " + internal_gw + " if " + env("TUNIDX"));
            echo(INFO, "Configured Legacy IP split-include route: " + network + "/" + netmasklen);
        }
    } else if (REDIRECT_GATEWAY_METHOD == 1) {
        run("route add 0.0.0.0 mask 0.0.0.0 " + internal_gw + " metric 1");
        echo(INFO, "Configured Legacy IP default route.");
    } else if (REDIRECT_GATEWAY_METHOD == 2) {
        run("route add 0.0.0.0 mask 128.0.0.0 " + internal_gw);
        run("route add 128.0.0.0 mask 128.0.0.0 " + internal_gw);
        echo(INFO, "Configured Legacy IP default route pair (0.0.0.0/1, 128.0.0.0/1)");
    }

    // Add excluded routes
    if (env("CISCO_SPLIT_EXC")) {
        for (var i = 0 ; i < parseInt(env("CISCO_SPLIT_EXC")); i++) {
            var network = env("CISCO_SPLIT_EXC_" + i + "_ADDR");
            var netmask = env("CISCO_SPLIT_EXC_" + i + "_MASK");
            var netmasklen = env("CISCO_SPLIT_EXC_" + i + "_MASKLEN");
            run("route add " + network + " mask " + netmask + " " + gw);
            echo(INFO, "Configured Legacy IP split-exclude route: " + network + "/" + netmasklen);
        }
    }
    echo(INFO, "Legacy IP route configuration done.");

    if (env("INTERNAL_IP6_ADDRESS")) {
        echo(INFO, "Configuring \"" + env("TUNDEV") + "\" / " + env("TUNIDX") + " interface for IPv6...");

        run("netsh interface ipv6 set address " + env("TUNIDX") + " " + env("INTERNAL_IP6_ADDRESS") + " store=active");

        echo(INFO, "done.");

        // Add internal network routes
        echo(INFO, "Configuring IPv6 networks:");
        if (env("INTERNAL_IP6_NETMASK") && !env("INTERNAL_IP6_NETMASK").match("/128$")) {
            run("netsh interface ipv6 add route " + env("INTERNAL_IP6_NETMASK") +
                " " + env("TUNIDX") + " store=active");
        }

        if (env("CISCO_IPV6_SPLIT_INC")) {
            for (var i = 0 ; i < parseInt(env("CISCO_IPV6_SPLIT_INC")); i++) {
                var network = env("CISCO_IPV6_SPLIT_INC_" + i + "_ADDR");
                var netmasklen = env("CISCO_IPV6_SPLIT_INC_" + i + "_MASKLEN");
                run("netsh interface ipv6 add route " + network + "/" +
                    netmasklen + " " + env("TUNIDX") + " store=active")
                echo(INFO, "Configured IPv6 split-include route: " + network + "/" + netmasklen);
            }
        } else {
            echo(INFO, "Setting default IPv6 route through VPN.");
            run("netsh interface ipv6 add route 2000::/3 " + env("TUNIDX") + " store=active");
        }

        // FIXME: handle IPv6 split-excludes

        echo(INFO, "IPv6 route configuration done.");
    }

    if (env("CISCO_BANNER")) {
        echo(INFO, "--------------------------------------------------");
        echo(INFO, env("CISCO_BANNER"));
        echo(INFO, "--------------------------------------------------");
    }
    break;
case "disconnect":
    echo(INFO, "Deconfiguring \"" + env("TUNDEV") + "\" / " + env("TUNIDX") + " interface...");

    // Delete explicit route for the VPN gateway
    // FIXME: handle IPv6 gateway address
    echo(INFO, "Removing explicit route to VPN gateway " + env("VPNGATEWAY"));
    run("route delete " + env("VPNGATEWAY") + " mask 255.255.255.255");

    // Delete address
    echo(INFO, "Removing" + (env("INTERNAL_IP6_ADDRESS") ? " IPv6 and" : "") + " Legacy IP addresses");
    run("netsh interface ipv4 del address " + env("TUNIDX") + " " +
        env("INTERNAL_IP4_ADDRESS") + " gateway=all");
    if (env("INTERNAL_IP6_ADDRESS")) {
        run("netsh interface ipv6 del address " + env("TUNIDX") + " " + env("INTERNAL_IP6_ADDRESS") + " store=active");
    }

    // Delete Legacy IP split-exclude routes
    if (env("CISCO_SPLIT_EXC")) {
        echo(INFO, "Removing Legacy IP split-exclude routes");
        for (var i = 0 ; i < parseInt(env("CISCO_SPLIT_EXC")); i++) {
            var network = env("CISCO_SPLIT_EXC_" + i + "_ADDR");
            var netmask = env("CISCO_SPLIT_EXC_" + i + "_MASK");
            var netmasklen = env("CISCO_SPLIT_EXC_" + i + "_MASKLEN");
            run("route delete " + network + " mask " + netmask );
        }
    }

    // FIXME: handle IPv6 split-excludes
    echo(INFO, "done.");
}
WScript.Quit(accumulatedExitCode);
