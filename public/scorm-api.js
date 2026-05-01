window.API = (function () {

    let initialized = false;
    let terminated = false;
    let data = {};

    return {

        LMSInitialize: function () {
            if (initialized) return "false";

            initialized = true;
            terminated = false;

            console.log("SCORM Initialized");
            return "true";
        },

        LMSFinish: function () {
            if (!initialized || terminated) return "false";

            terminated = true;

            console.log("SCORM Finished");
            return "true";
        },

        LMSGetValue: function (key) {
            console.log("GET:", key);

            switch (key) {
                case "cmi.core.student_id":
                    return "USER_001";

                case "cmi.core.student_name":
                    return "Test User";

                case "cmi.core.lesson_status":
                    return "not attempted";

                case "cmi.suspend_data":
                    return localStorage.getItem("suspend_data") || "";

                default:
                    return "";
            }
        },

        LMSSetValue: function (key, value) {
            console.log("SET:", key, value);

            if (key === "cmi.suspend_data") {
                localStorage.setItem("suspend_data", value);
            }

            localStorage.setItem(key, value);
            return "true";
        },

        LMSCommit: function () {
            if (!initialized) return "false";

            console.log("Commit");
            return "true";
        },

        LMSGetLastError: function () {
            return "0";
        },

        LMSGetErrorString: function () {
            return "No error";
        },

        LMSGetDiagnostic: function () {
            return "No diagnostic";
        }
    };

})();