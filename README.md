# openconnect-windows-mod

Openconnect for windows , based on v8.02
<p>
  fixes stdout logging for running in js based platforms e.g. NodeJS (only needed outputs) 
  <p>
    + Automatic verification and --passwd support (also related to js enviroments problem)
  </p>
</p>


# what has changed
1. pass your password with --passwd=xxx [safely, maybe] (also support regular password stdin)
2. Automatic certificate verification [safelt]
3. Error Handling : **connected** as successfull in stdout and **error** for disconnection (also listening on process on exit)
4. Always-Enabled stats logging in [rx,tx] form; must convert to array and use
