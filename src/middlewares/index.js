const {
    createProxyMiddleware,
    responseInterceptor
} = require("http-proxy-middleware");
const cheerio = require("cheerio");
const base64 = require("base-64");
const fs = require("fs");
const {
    genSess,
    decodeSess,
    isValidSess,
    isAccessable,
    getFormQueryStr,
    JSON_to_URLEncoded,
    spamzillaAutoLogin
} = require("../services/utils");
const sistrixMiddleware = require("./sistrixMiddleware");
const settingModel = require("../models/setting");
const proxyModel = require("../models/proxy");
const domainOverviewModel = require("../models/domainOverview");
const keywordOverviewModel = require("../models/keywordOverview");

const sessionMapper = new Map();

const notFoundMiddleware = (req, res, next) => {
    res.status(404);
    const error = new Error(`🔍 - Not Found - ${req.originalUrl}`);
    next(error);
}

const errorHandleMiddleware = (err, req, res, next) => {
    console.log(err);
    const statusCode = res.statusCode !== 200 ? res.statusCode : 500;
    res.status(statusCode);
    res.render("error", { 
        message: err.message,         
        stack: process.env.NODE_ENV === "production" ? "🥞" : err.stack
    });
}

const authMiddleware = async (req, res, next) => {
    let domain = req.headers["host"];
    let userAgent = req.headers["user-agent"];
    let ipAddr = process.env.NODE_ENV == "development" ? "45.126.3.252" : req.headers["x-forwarded-for"];
    let { sess, site } = req.body;
    if (!sess) {
        return res.status(400).end("Bad Request, please try again.");
    }
    if (!isValidSess(sess, userAgent, ipAddr)) {
        return res.status(400).end("Session is invalid");
    }
    let { dataBuffer, data } = decodeSess(sess);
    let newSess = genSess(dataBuffer, userAgent, ipAddr);
    let user = {
        id: data[0],
        isAdmin: Number(data[3]),
        username: data[1].split("=")[1].split("|")[0],
        accessAble: Number(data[3]) ? true : await isAccessable(data[0], site)
    }
    sessionMapper.set(`${site}-${user.id}`, newSess);
    res.cookie("sess", newSess, {
        path: "/",
        domain: process.env.NODE_ENV === "development" ? undefined : domain
    });
    res.cookie("wpInfo", base64.encode(JSON.stringify({user, site})), {
        path: "/",
        domain: process.env.NODE_ENV === "development" ? undefined : domain
    });
    res.cookie("prefix", "www", {
        path: "/",
        domain: process.env.NODE_ENV === "development" ? undefined : domain
    });    
    next();
}
const memberMiddleware = (req, res, next) => {
    if (req.url.match(/\.(css|json|js|text|png|jpg|map|ico|svg)/)) return next();

    let { wpInfo, sess } = req.cookies;
    if (!wpInfo || !sess) return res.status(400).end('Access Denined.');
    
    let userAgent = req.headers['user-agent'];
    let ipAddr = process.env.NODE_ENV == 'development' ? '45.126.3.252' : req.headers['x-forwarded-for'];

    if (!isValidSess(sess, userAgent, ipAddr)) return res.status(400).end('Session is invalid.');
    
    let wpInfoDecoded = JSON.parse(base64.decode(wpInfo));
    if (!wpInfoDecoded.user.accessAble) return res.status(400).end('Membership required.');
    if (!sessionMapper.get(`${wpInfoDecoded.site}-${wpInfoDecoded.user.id}`)) sessionMapper.set(`${wpInfoDecoded.site}-${wpInfoDecoded.user.id}`, sess);
    req.user = wpInfoDecoded.user;
    req.wpSite = wpInfoDecoded.site;
    next();
}

const jsonMiddleware = (req, res, next) => {
    let contentType = req.headers["content-type"];
    if (contentType && contentType.includes("application/json")) {
        req.headers["content-type"] = "application/json; charset=UTF-8";
    }
    next();
}

const nextMiddleware = (req, res, next) => {
    next();
}

const semrushMiddleware = (prefix) => {
    return createProxyMiddleware({
        target: `https://${prefix}.semrush.com`,
        selfHandleResponse: true,
        changeOrigin: true,
        onProxyReq: (proxyReq, req) => {
            let userAgent = req.headers["user-agent"];
            let { cookie } = req.proxy;
            proxyReq.setHeader("user-agent", userAgent);
            proxyReq.setHeader("Cookie", cookie);
            
            if (["POST", "PATCH", "PUT"].includes(req.method)) {
                let contentType = proxyReq.getHeader("content-type");
                const writeBody = (bodyData) => {
                    proxyReq.setHeader("content-length", Buffer.byteLength(bodyData));
                    proxyReq.write(bodyData);
                }
                
                if (contentType && contentType.includes("application/json")) {
                    writeBody(JSON.stringify(req.body));
                }

                if (contentType && contentType.includes("application/x-www-form-urlencoded")) {
                    let body = getFormQueryStr(req.body);
                    proxyReq.setHeader("content-type", "application/x-www-form-urlencoded");
                    writeBody(body);
                }
            }
        },
        onProxyRes: responseInterceptor(
            (responseBuffer, proxyRes, req, res) => {
                let domain = `https://${req.headers["host"]}`;
                if (req.url.match(/\.(css|json|js|text|png|jpg|map|ico|svg)/)) {
                    return responseBuffer;
                }
                if (proxyRes.headers["location"]) {
                    let locale = "", target = "";
                    try {
                        let url = new URL(proxyRes.headers.location);
                        target = url.origin;
                        locale = url.hostname.split(".")[0];
                    } catch (err) {
                        target = `https://${prefix}.semrush.com`;
                    }

                    if (proxyRes.statusCode == 302) {
                        if (/^(http|https)/.test(proxyRes.headers["location"])) {
                            proxyRes.headers["location"] = `/lang/semrush?prefix=${locale}`;
                            res.setHeader("location", `/lang/semrush?prefix=${locale}`);
                        }
                    } else {
                        proxyRes.headers["location"] = proxyRes.headers["location"].replace(target, domain);
                        res.setHeader("location", proxyRes.headers["location"].replace(target, domain));
                    }
                }
                if (proxyRes.headers["content-type"] && proxyRes.headers["content-type"].includes("text/html")) {
                    let response = responseBuffer.toString("utf-8");
                    let $ = cheerio.load(response);
                    $("head").append("<script src='https://code.jquery.com/jquery-3.6.1.min.js' integrity='sha256-o88AwQnZB+VDvE9tvIXrMQaPlFFSUTR+nldQm1LuPXQ=' crossorigin='anonymous'></script>");
                    $("head").append("<script src='/js/semrush.js' type='text/javascript'></script>");
                    $(".srf-header .srf-navbar__right .srf-login-btn, .srf-header .srf-navbar__right .srf-register-btn").remove();
                    if (req.user.isAdmin) {
                        return $.html();
                    } else {
                        if (req.url == "/accounts/profile/account-info" || req.url == "/billing-admin/profile/subscription") {
                            $(".srf-layout__sidebar, .srf-layout__body").remove();
                            $(".srf-layout__footer").before("<h1 style='grid-area: footer; display: block; margin-top: -150px; text-align: center; font-size: 40px; color: #ff642d; font-weight: bold'>You can not access in this page.</h1>");
                          }
                        $(".srf-navbar__right").remove();
                        return $.html();
                    }
                }
                return responseBuffer;
            }
        ),
        prependPath: true,
        secure: false,
        hostRewrite: true,
        headers: {
            referer: `https://${prefix}.semrush.com`,
            origin: `https://${prefix}.semrush.com`
        },
        autoRewrite: true,
        ws: true
    });
}

const semrushLimitMiddleware = async (req, res) => {
    if (!req.url.match(/\.(css|json|js|text|png|jpg|map|ico|svg)/)) {
        let { id, username, isAdmin } = req.user;
        let { wpSite } = req;
        if (
            !isAdmin && 
            /\/analytics\/overview\//.test(req.originalUrl)
        ) {
            const total = await domainOverviewModel.countRequests(id, username, wpSite, "semrush");
            const limit = await settingModel.getOverviewLimit("semrushDomainOverviewLimit");
            if (total > limit) {
                return {
                    next: false,
                    type: "html",
                    data: `<div class="text-center text-danger">Your daily limit is reached.</div>`
                }              
            }
        } else if (
            !isAdmin &&
            /\/dpa\/rpc/.test(req.originUrl) &&
            typeof req.body == "object" &&
            typeof req.body.params == "object" &&
            req.body.method == "dpa.IsRootDomain" &&
            req.body.params.report == "domain.overview"
        ) {
            await domainOverviewModel.create({
                userId: id,
                username: username,
                site: wpSite,
                proxyType: "semrush",
                domain: req.body.params.args.searchItem
            });
        }
        if (
            !isAdmin &&
            (
                /\/analytics\/keywordoverview\//.test(req.originalUrl) || 
                /\/analytics\/keywordmagic\//.test(req.originalUrl)
            )
        ) {
            const total = await keywordOverviewModel.countRequests(id, username, wpSite, "semrush");
            const limit = await settingModel.getOverviewLimit("semrushKeywordOverviewLimit");
            if (total > limit) {
                return {
                    next: false,
                    type: "html",
                    data: `<div class="text-center text-danger">Your daily limit is reached.</div>`
                }     
            }
        } else if (
            !isAdmin &&
            req.method.toUpperCase() == "POST" &&
            typeof req.body == "object" &&
            (
                (/\/kwogw\/rpc/.test(req.originalUrl) && req.body.method == "fts.GetKeywords") ||
                (/\/kmtgw\/rpc/.test(req.originalUrl) && req.body.method == "fts.GetKeywords")
            ) && req.body.id == 5
        ) {
            await keywordOverviewModel.create({
                userId: id,
                username: username,
                site: wpSite,
                proxyType: "semrush",
                phases: [req.body.params.phrase]
            });
        }
    }
    return {
        next: true
    }
}

const spyfuMiddleware = (prefix) => {
    return createProxyMiddleware({
        target: `https://${prefix}.spyfu.com`,
        selfHandleResponse: true,
        changeOrigin: true,
        onProxyReq: (proxyReq, req) => {
            let userAgent = req.headers["user-agent"];
            let { cookie } = req.proxy;
            proxyReq.removeHeader("sec-ch-ua");
            proxyReq.removeHeader("sec-ch-ua-mobile");
            proxyReq.removeHeader("sec-ch-ua-platform");
            proxyReq.removeHeader("sec-fetch-user");
            proxyReq.removeHeader("upgrade-insecure-requests");
            proxyReq.removeHeader("connection");
            proxyReq.removeHeader("pragma");
            proxyReq.removeHeader("accept-language");
            proxyReq.removeHeader("accept-encoding");
            proxyReq.setHeader("user-agent", userAgent);
            proxyReq.setHeader("Cookie", cookie);
            proxyReq.setHeader("host", `${prefix}.spyfu.com`)
            if (["POST", "PATCH", "PUT"].includes(req.method)) {
                let contentType = proxyReq.getHeader("content-type");
                const writeBody = (bodyData) => {
                    proxyReq.setHeader("content-length", Buffer.byteLength(bodyData));
                    proxyReq.write(bodyData);
                }
                
                if (contentType && contentType.includes("application/json")) {
                    writeBody(JSON.stringify(req.body));
                }

                if (contentType && contentType.includes("application/x-www-form-urlencoded")) {
                    let body = getFormQueryStr(req.body);
                    proxyReq.setHeader("content-type", "application/x-www-form-urlencoded");
                    writeBody(body);
                }
            }
        },
        onProxyRes: responseInterceptor(
            (responseBuffer, proxyRes, req, res) => {
                let domain = `https://${req.headers["host"]}`;
                if (req.url.match(/\.(css|json|js|text|png|jpg|map|ico|svg)/)) {
                    return responseBuffer;
                }
                if (proxyRes.headers["location"]) {
                    proxyRes.headers["location"] = proxyRes.headers["location"].replace(`https://${prefix}.spyfu.com`, domain);
                    res.setHeader("location", proxyRes.headers["location"].replace(`https://${prefix}.spyfu.com`, domain));
                }
                if (proxyRes.headers["content-type"] && proxyRes.headers["content-type"].includes("text/html")) {
                    let response = responseBuffer.toString("utf-8");
                    let $ = cheerio.load(response);
                    $("head").append("<script src='https://code.jquery.com/jquery-3.6.1.min.js' integrity='sha256-o88AwQnZB+VDvE9tvIXrMQaPlFFSUTR+nldQm1LuPXQ=' crossorigin='anonymous'></script>");
                    $("head").append(`<script>var locale = "${prefix}"; var isAdmin = ${req.user.isAdmin ? true : false};</script>`);
                    $("head").append("<script src='/js/spyfu.js' type='text/javascript'></script>");
                    return $.html();
                }
                return responseBuffer;
            }
        ),
        prependPath: true,
        secure: false,
        hostRewrite: true,
        headers: {
            referer: `https://${prefix}.spyfu.com`,
            origin: `https://${prefix}.spyfu.com`
        },
        autoRewrite: true,
        ws: true
    });
}

const spyfuLimitMiddleware = async (req, res, next) => {
    if (!req.originalUrl.match(/\.(css|json|js|text|png|jpg|map|ico|svg)/)) {
        let { id, username, isAdmin } = req.user;
        let wpSite = req.wpSite;
        if (!isAdmin && (req.path == "/account" || req.path == "/account/subscription")) {
            return {
                next: false,
                redirect: true,
                path: "/"
            }
        }
        if (
            !isAdmin &&
            /\/Endpoints\/Search\/JsonSearch/.test(req.originalUrl) &&
            req.query.isSiteQuery == "true"
        ) {
            const total = await domainOverviewModel.countRequests(id, username, wpSite, "spyfu");
            const limit = await settingModel.getOverviewLimit("spyfuDomainOverviewLimit");
            if (total > limit) {
                return {
                    next: false,
                    redirect: false,
                    data: {
                        IsSerpBacked: false,
                        ResultType: "Domain",
                        ResultTypeId: 0,
                        Searches: 0,
                        WasQueryFound: false    
                    }
                }
            } else {
                await domainOverviewModel.create({
                    userId: id,
                    username: username,
                    site: wpSite,
                    proxyType: "spyfu",
                    domain: req.query.query
                });
            }
        }
        if (
            !isAdmin &&
            /\/Endpoints\/Search\/JsonSearch/.test(req.originalUrl) && 
            req.query.isSiteQuery == "false"
        ) {
            const total = await keywordOverviewModel.countRequests(id, username, wpSite, "spyfu");
            const limit = await settingModel.getOverviewLimit("spyfuKeywordOverviewLimit");
            if (total > limit) {
                return {
                    next: false,
                    redirect: false,
                    data: {
                        IsSerpBacked: false,
                        ResultType: "Term",
                        ResultTypeId: 0,
                        Searches: 0,
                        WasQueryFound: false    
                    }
                }
            } else {
                await keywordOverviewModel.create({
                    userId: id,
                    username: username,
                    site: wpSite,
                    proxyType: "spyfu",
                    phases: [req.query.query]
                });
            }
        }
    }
    return {
        next: true
    }
}

const seolyzeMiddleware = (prefix) => {
    return createProxyMiddleware({
        target: `https://www.seolyze.com`,
        selfHandleResponse: true,
        changeOrigin: true,
        onProxyReq: (proxyReq, req) => {
            let userAgent = req.headers["user-agent"];
            let { cookie } = req.proxy;
            proxyReq.setHeader("user-agent", userAgent);
            proxyReq.setHeader("Cookie", cookie);
            if (["POST", "PATCH", "PUT"].includes(req.method)) {
                let contentType = proxyReq.getHeader("content-type");
                const writeBody = (bodyData) => {
                    proxyReq.setHeader("content-length", Buffer.byteLength(bodyData));
                    proxyReq.write(bodyData);
                }
                
                if (contentType && contentType.includes("application/json")) {
                    writeBody(JSON.stringify(req.body));
                }

                if (contentType && contentType.includes("application/x-www-form-urlencoded")) {
                    let body = getFormQueryStr(req.body);
                    proxyReq.setHeader("content-type", "application/x-www-form-urlencoded");
                    writeBody(body);
                }
            }
        },
        onProxyRes: responseInterceptor(
            (responseBuffer, proxyRes, req, res) => {
                let domain = `https://${req.headers["host"]}`;
                if (req.url.match(/\.(css|json|js|text|png|jpg|map|ico|svg)/)) {
                    return responseBuffer;
                }
                if (req.path == "/") {
                    proxyRes.statusCode = 301;
                    proxyRes.headers["location"] =  `${domain}/EPS-KF/`;
                    res.statusCode = 301;
                    res.setHeader("location", `${domain}/EPS-KF/`);
                }
                if (proxyRes.headers["location"]) {
                    proxyRes.headers["location"] = proxyRes.headers["location"].replace("https://www.seolyze.com", domain);
                    res.setHeader("location", proxyRes.headers["location"].replace("https://www.seolyze.com", domain));
                }
                if (proxyRes.headers["content-type"] && proxyRes.headers["content-type"].includes("text/html")) {
                    let response = responseBuffer.toString("utf-8");
                    response = response.replace(/https:\/\/www.seolyze.com/g, domain);
                    let $ = cheerio.load(response);
                    $("head").append("<script src='https://code.jquery.com/jquery-3.6.1.min.js' integrity='sha256-o88AwQnZB+VDvE9tvIXrMQaPlFFSUTR+nldQm1LuPXQ=' crossorigin='anonymous'></script>");
                    $("head").append("<script src='/js/seolyze.js' type='text/javascript'></script>");
                    return $.html();
                }
                return responseBuffer;
            }
        ),
        prependPath: true,
        secure: false,
        hostRewrite: true,
        headers: {
            referer: "https://www.seolyze.com",
            origin: "https://www.seolyze.com"
        },
        autoRewrite: true,
        ws: true
    });
}

const linkcentaurMiddleware = (prefix) => createProxyMiddleware({
    target: `https://www.linkcentaur.com`,
    selfHandleResponse: true,
    changeOrigin: true,
    onProxyReq: (proxyReq, req) => {
        let userAgent = req.headers["user-agent"];
        let { cookie } = req.proxy;
        proxyReq.setHeader("user-agent", userAgent);
        proxyReq.setHeader("Cookie", cookie);
        
        if (["POST", "PATCH", "PUT"].includes(req.method)) {
            let contentType = proxyReq.getHeader("content-type");
            const writeBody = (bodyData) => {
                proxyReq.setHeader("content-length", Buffer.byteLength(bodyData));
                proxyReq.write(bodyData);
            }
            
            if (contentType && contentType.includes("application/json")) {
                writeBody(JSON.stringify(req.body));
            }

            if (contentType && contentType.includes("application/x-www-form-urlencoded")) {
                let body = JSON_to_URLEncoded(req.body);
                proxyReq.setHeader("content-type", "application/x-www-form-urlencoded");
                writeBody(body);
            }
            
            if (contentType && contentType.includes("multipart/form-data")) {
                proxyReq.setHeader("content-type", "application/json");
                if (typeof req.body.links_form !== "undefined") {
                    req.body.links_form.urls_input_mode = "form";
                }
                writeBody(JSON.stringify(req.body));
            }
        }
    },
    onProxyRes: responseInterceptor(
        (responseBuffer, proxyRes, req, res) => {
            let domain = `https://${req.headers["host"]}`;
            if (req.url.match(/\.(css|json|js|text|png|jpg|map|ico|svg)/)) {
                return responseBuffer;
            }
            if (proxyRes.headers["location"]) {
                proxyRes.headers["location"] = proxyRes.headers["location"].replace("https://www.linkcentaur.com", domain);
                res.setHeader("location", proxyRes.headers["location"].replace("https://www.linkcentaur.com", domain));
            }
            if (typeof req.user == "object" && !req.user.isAdmin && req.path == "/account") {
                proxyRes.statusCode = 301;
                proxyRes.headers["location"] = domain;
                res.statusCode = 301;
                res.setHeader("location", domain);
            }
            if (proxyRes.headers["content-type"] && proxyRes.headers["content-type"].includes("text/html")) {
                let response = responseBuffer.toString("utf-8");
                let $ = cheerio.load(response);
                $("head").append("<script src='/js/linkcentaur.js' type='text/javascript'></script>");
                if (typeof req.user == "object" && !req.user.isAdmin) {  
                    $("#menu li:nth-child(1)").remove();
                }
                if (/^\/campaigns\/\w/.test(req.path)) {
                    $(".links_form_urls_input_mode").remove();
                }
                return $.html();
            }
            return responseBuffer;
        }
    ),
    prependPath: true,
    secure: false,
    hostRewrite: true,
    headers: {
        referer: "https://www.linkcentaur.com",
        origin: "https://www.linkcentaur.com"
    },
    autoRewrite: true,
    ws: true
});

const spamzillaMiddleware = (prefix) => createProxyMiddleware({
    target: `https://www.spamzilla.io`,
    selfHandleResponse: true,
    changeOrigin: true,
    onProxyReq: (proxyReq, req) => {
        let userAgent = req.headers["user-agent"];
        let { cookie } = req.proxy;
        proxyReq.setHeader("user-agent", userAgent);
        proxyReq.setHeader("Cookie", cookie);
        
        if (["POST", "PATCH", "PUT"].includes(req.method)) {
            let contentType = proxyReq.getHeader("content-type");
            const writeBody = (bodyData) => {
                proxyReq.setHeader("content-length", Buffer.byteLength(bodyData));
                proxyReq.write(bodyData);
            }
            
            if (contentType && contentType.includes("application/json")) {
                writeBody(JSON.stringify(req.body));
            }

            if (contentType && contentType.includes("application/x-www-form-urlencoded")) {
                let body = JSON_to_URLEncoded(req.body);
                proxyReq.setHeader("content-type", "application/x-www-form-urlencoded");
                writeBody(body);
            }
            
            if (contentType && contentType.includes("multipart/form-data")) {
                proxyReq.setHeader("content-type", "application/json");
                writeBody(JSON.stringify(req.body));
            }
        }
    },
    onProxyRes: responseInterceptor(
        async (responseBuffer, proxyRes, req, res) => {
            let domain = `https://${req.headers["host"]}`;
            if (req.url.match(/\.(css|json|js|text|png|jpg|map|ico|svg)/)) {
                return responseBuffer;
            }
            
            if (req.path == "/do-auto-login") {
                try {
                    let { username, password } = await credentialModel.findOne({"type": "smapzilla"});
                    let result = await spamzillaAutoLogin(username, password);
                    if (result) {
                        res.statusCode = 200;
                        return JSON.stringify({status: true});
                    } else {
                        res.statisCode = 200;
                        return JSON.stringify({status: false});
                    }
                } catch (err) {
                    res.statusCode = 200;
                    return JSON.stringify({status: false});
                }
            }
            if (proxyRes.headers["location"]) {
                proxyRes.headers["location"] = proxyRes.headers["location"].replace("https://www.spamzilla.io", domain);
                res.setHeader("location", proxyRes.headers["location"].replace("https://www.spamzilla.io", domain));
            }
            if (
                typeof req.user == "object" && 
                !req.user.isAdmin && (
                    /\/account\//.test(req.path) ||
                    /\/settings\//.test(req.path)
                )
            ) {
                proxyRes.statusCode = 301;
                proxyRes.headers["location"] = domain;
                res.statusCode = 301;
                res.setHeader("location", domain);
            }
            if (
                proxyRes.headers["content-type"] && 
                proxyRes.headers["content-type"].includes("text/html")
            ) {
                let response = responseBuffer.toString("utf-8");
                if (/tools\/export\//.test(req.path) || /expired-domains\/export\//.test(req.path)) {
                    return responseBuffer;
                } else if (req.method === "POST" && /\/domains/.test(req.path)) {
                    let content = responseBuffer.toString("utf-8");
                    content = content.replace(/https:\/\/www.spamzilla.io/g, domain);
                    res.statusCode = 200;
                    return content;
                } else {
                    let $ = cheerio.load(response);
                    let anchors = $("a");
                    anchors.each(function() {
                        const href = $(this).attr("href");
                        if (/www.spamzilla.io/.test(href)) {
                            $(this).attr("href", href.replace(/https:\/\/www.spamzilla.io/g, domain));
                        }
                    });
                    
                    $(".free-user").remove();
                    $(".domains-form > p").remove();
                    $(".domains-form .form-group:nth-child(3)").css("display", "none");
                    if (typeof req.user == "object" && !req.user.isAdmin) {  
                        $("a[title='Settings']").parent().remove();
                        $("a[title='Profile']").parent().remove();
                        $("a[title='Logout']").parent().remove();
                    }
                    if (req.path == "/account/login/") {
                        let html = fs.readFileSync(__dirname + "/../views/spamzilla-auth.ejs");
                        return html.toString();
                    } 
                    return $.html();
                }
            }
            return responseBuffer;
        }
    ),
    prependPath: true,
    secure: false,
    hostRewrite: true,
    headers: {
        referer: "https://www.spamzilla.io",
        origin: "https://www.spamzilla.io"
    },
    autoRewrite: true,
    ws: true
});

const seodityMiddleware = (prefix) => createProxyMiddleware({
    target: `https://app.seodity.com`,
    selfHandleResponse: true,
    changeOrigin: true,
    onProxyReq: (proxyReq, req) => {
        let userAgent = req.headers["user-agent"];
        proxyReq.setHeader("user-agent", userAgent);
        if (["POST", "PATCH", "PUT"].includes(req.method)) {
            let contentType = proxyReq.getHeader("content-type");
            const writeBody = (bodyData) => {
                proxyReq.setHeader("content-length", Buffer.byteLength(bodyData));
                proxyReq.write(bodyData);
            }
            
            if (contentType && contentType.includes("application/json")) {
                writeBody(JSON.stringify(req.body));
            }

            if (contentType && contentType.includes("application/x-www-form-urlencoded")) {
                let body = JSON_to_URLEncoded(req.body);
                proxyReq.setHeader("content-type", "application/x-www-form-urlencoded");
                writeBody(body);
            }
            
            if (contentType && contentType.includes("multipart/form-data")) {
                proxyReq.setHeader("content-type", "application/json");
                writeBody(JSON.stringify(req.body));
            }
        }
    },
    onProxyRes: responseInterceptor(
        async (responseBuffer, proxyRes, req, res) => {
            let domain = `https://${req.headers["host"]}`;
            if (req.url.match(/\.(css|json|js|text|png|jpg|map|ico|svg)/)) {
                return responseBuffer;
            }
            if (
                typeof req.user == "object" && 
                !req.user.isAdmin && (
                    /\/plan/.test(req.path) ||
                    /\/invoices/.test(req.path) ||
                    /\/settings\/user/.test(req.path)
                )
            ) {
                proxyRes.statusCode = 301;
                proxyRes.headers["location"] = domain;
                res.statusCode = 301;
                res.setHeader("location", domain);
            }
            if (proxyRes.headers["location"]) {
                proxyRes.headers["location"] = proxyRes.headers["location"].replace("https://app.seodity.com", domain);
                res.setHeader("location", proxyRes.headers["location"].replace("https://app.seodity.com", domain));
            }
            if (
                proxyRes.headers["content-type"] && 
                proxyRes.headers["content-type"].includes("text/html")
            ) {
                let response = responseBuffer.toString("utf-8");
                let $ = cheerio.load(response);
                $("head").append(`
                    <style>
                        .sc-cxVPaa.sc-dYtuZ.kCgBgd > :nth-child(3),
                        .sc-cxVPaa.sc-dYtuZ.kCgBgd > :nth-child(3) {
                            display: none;
                        }
                        .sc-jNHqnW.idkeaS {
                            display: none;
                        }
                    </style>`);
                $("head").append(`<script>var user = ${JSON.stringify(req.user)};</script>`);
                $("head").append("<script src='/js/seodity.js' type='text/javascript'></script>");
                return $.html();
            }
            return responseBuffer;
        }
    ),
    prependPath: true,
    secure: false,
    hostRewrite: true,
    headers: {
        referer: "https://app.seodity.com",
        origin: "https://app.seodity.com"
    },
    autoRewrite: true,
    ws: true
});

const rytrmeMiddleware = (prefix) => createProxyMiddleware({
    target: `https://app.rytr.me`,
    selfHandleResponse: true,
    changeOrigin: true,
    onProxyReq: (proxyReq, req) => {
        let userAgent = req.headers["user-agent"];
        proxyReq.setHeader("user-agent", userAgent);
        if (["POST", "PATCH", "PUT"].includes(req.method)) {
            let contentType = proxyReq.getHeader("content-type");
            const writeBody = (bodyData) => {
                proxyReq.setHeader("content-length", Buffer.byteLength(bodyData));
                proxyReq.write(bodyData);
            }
            
            if (contentType && contentType.includes("application/json")) {
                writeBody(JSON.stringify(req.body));
            }

            if (contentType && contentType.includes("application/x-www-form-urlencoded")) {
                let body = JSON_to_URLEncoded(req.body);
                proxyReq.setHeader("content-type", "application/x-www-form-urlencoded");
                writeBody(body);
            }
            
            if (contentType && contentType.includes("multipart/form-data")) {
                proxyReq.setHeader("content-type", "application/json");
                writeBody(JSON.stringify(req.body));
            }
        }
    },
    onProxyRes: responseInterceptor(
        async (responseBuffer, proxyRes, req, res) => {
            let domain = `https://${req.headers["host"]}`;
            if (req.url.match(/\.(css|json|js|text|png|jpg|map|ico|svg)/)) {
                return responseBuffer;
            }
            if (
                typeof req.user == "object" && 
                req.user.isAdmin && /\/account/.test(req.path)
            ) {
                proxyRes.statusCode = 301;
                proxyRes.headers["location"] = domain + "/ryte";
                res.statusCode = 301;
                res.setHeader("location", domain + "/ryte");
            }
            if (proxyRes.headers["location"]) {
                proxyRes.headers["location"] = proxyRes.headers["location"].replace("https://app.rytr.me", domain);
                res.setHeader("location", proxyRes.headers["location"].replace("https://app.rytr.me", domain));
            }
            if (
                proxyRes.headers["content-type"] && 
                proxyRes.headers["content-type"].includes("text/html")
            ) {
                let response = responseBuffer.toString("utf-8");
                let $ = cheerio.load(response);
                if (req.proxy.cookie) {
                    let {token, user} = JSON.parse(req.proxy.cookie);
                    console.log($.html());
                    $("head").append(`<script>
                        var token = localStorage.getItem("token");
                        if (!token) {
                            window.localStorage.setItem("token", '${token}');
                            window.localStorage.setItem("user", '${JSON.stringify(user)}')
                        }
                        window.onload = function() {
                            document.querySelector(".style_left__nUNqr > a:nth-child(3)").remove();
                        }
                    </script>`);
                }
                return $.html();
            }
            return responseBuffer;
        }
    ),
    prependPath: true,
    secure: false,
    hostRewrite: true,
    headers: {
        referer: "https://app.rytr.me",
        origin: "https://app.rytr.me"
    },
    autoRewrite: true,
    ws: true
});

const applyMiddleware = async (req, res, next) => {
    let domain = req.headers["host"];
    domain = "rytr.oceanserver.link";
    let setting = await settingModel.findOne();
    let proxy = await proxyModel.findOne({domain});
    if (proxy !== null) {
        if (setting != null) {
            let prefix = (typeof req.cookies.prefix == "undefined" || req.cookies.prefix == "") ? "www" : req.cookies.prefix;
            req.proxy = {
                prefix,
                cookie: setting[`${proxy.type}Cookie`]
            }
            if (proxy.type == "semrush") {
                let result = await semrushLimitMiddleware(req, res);
                if (result.next) {
                    return semrushMiddleware(prefix)(req, res, next);
                } else {
                    if (result.type == "json") {
                        return res.json(result.data);
                    } else {
                        return res.send(result.data);
                    }
                }
            } else if (proxy.type == "spyfu") {
                let result = await spyfuLimitMiddleware(req, res);
                if (result.next) {
                    return spyfuMiddleware(prefix)(req, res, next);
                } else {
                    if (result.redirect) {
                        return res.status(301).redirect(result.path);
                    } else {
                        return res.json(result.data);
                    }
                }
            } else if (proxy.type == "seolyze") {
                return seolyzeMiddleware(prefix)(req, res, next);
            } else if (proxy.type == "sistrix") {
                sistrixMiddleware(req, res, next);
            } else if (proxy.type == "linkcentaur") {
                return linkcentaurMiddleware(prefix)(req, res, next);
            } else if (proxy.type == "spamzilla") {
                return spamzillaMiddleware(prefix)(req, res, next);
            } else if (proxy.type == "seodity") {
                res.cookie("jwt-token", req.proxy.cookie, {
                    path: "/",
                    domain: process.env.NODE_ENV === "development" ? undefined : domain
                });
                return seodityMiddleware(prefix)(req, res, next);
            } else if (proxy.type == "rytrme") {
                return rytrmeMiddleware(prefix)(req, res, next);
            }
        } else {
            return res.render("warning", { msg: "Admin have to set up some proxy-related setting."});
        }
    } else {
        return res.render("warning", {msg: "The domain is not registered in our application."});
    }
}

module.exports = {
    notFoundMiddleware,
    errorHandleMiddleware,
    authMiddleware,
    memberMiddleware,
    jsonMiddleware,
    nextMiddleware,
    spyfuMiddleware,
    applyMiddleware
}