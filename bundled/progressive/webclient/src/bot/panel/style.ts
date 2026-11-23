export const css = `
#personal-shell{display:flex;align-items:flex-start;justify-content:center;gap:8px;max-width:1500px;margin:12px auto;padding:0 8px;box-sizing:border-box;text-align:left}
#personal-shell #game{margin:0;min-width:0;flex:1 1 765px;max-width:calc(100% - 298px)}
#personal-shell #canvas{max-width:100%!important;height:auto!important}
.hb-panel,.hb-dialog{font:12px/1.5 system-ui,sans-serif;color:#e3e7ed;background:#15191f;border:1px solid #303740;border-radius:8px;box-sizing:border-box;text-align:left;color-scheme:dark}
.hb-panel{flex:0 0 290px;padding:14px;max-height:calc(100vh - 24px);overflow:auto;scrollbar-width:thin}
.hb-panel h2,.hb-dialog h2{font-size:16px;margin:0 0 4px}.hb-panel h3{font-size:11px;text-transform:uppercase;letter-spacing:.1em;margin:14px 0 8px;color:#a9b3c0}
.hb-panel section{border-top:1px solid #303740;margin-top:12px;padding-top:2px}.hb-panel p{font:inherit;color:inherit;margin:6px 0}
.hb-panel button,.hb-panel input,.hb-panel select,.hb-dialog button,.hb-dialog input,.hb-dialog select{font:inherit;border:1px solid #3a4552;border-radius:4px;padding:6px 8px;background:#232a33;color:#e3e7ed;box-sizing:border-box}
.hb-panel button,.hb-dialog button{cursor:pointer}.hb-panel button:hover,.hb-dialog button:hover{border-color:#70c8b6}.hb-panel button:disabled{opacity:.4;cursor:default}
.hb-panel button:focus-visible,.hb-panel input:focus-visible,.hb-panel select:focus-visible{outline:2px solid #70c8b6}
.hb-panel input[type=search],.hb-panel select{width:100%;margin-bottom:6px}.hb-panel input[type=checkbox]{margin-right:8px}
.hb-row{display:flex;gap:5px;margin:8px 0;flex-wrap:wrap}.hb-row button{flex:1}.hb-panel .hb-card{display:block;width:100%;text-align:left;background:#1c232b;margin:4px 0;padding:10px}.hb-card strong{display:block;color:#8bd9c8}.hb-card span{font-size:10px}
.hb-muted{color:#96a3b2!important}.hb-error{color:#ffb3ab!important}.hb-status{border-left:3px solid #70c8b6;padding-left:8px;overflow-wrap:anywhere}
.hb-panel dl{display:grid;grid-template-columns:80px 1fr;gap:4px;margin:8px 0}.hb-panel dt{color:#96a3b2}.hb-panel dd{margin:0;overflow-wrap:anywhere}.hb-panel pre{white-space:pre-wrap;overflow-wrap:anywhere;font:10px/1.5 ui-monospace,monospace;max-height:180px;overflow:auto;color:#adb9c7}.hb-panel details summary{cursor:pointer;margin:8px 0}
.hb-dialog{width:min(440px,95vw);padding:20px}.hb-dialog::backdrop{background:#0009}.hb-dialog label{display:block;margin:14px 0}.hb-dialog label input:not([type=checkbox]),.hb-dialog label select{display:block;width:100%;margin-top:4px}.hb-dialog button{margin-right:8px}
@media(max-width:850px){#personal-shell{flex-direction:column}#personal-shell #game{max-width:100%;flex:initial;width:100%}.hb-panel{flex:initial;width:100%;max-height:none}}
`;
